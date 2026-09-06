import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { getSettings, setSettings, defaultSettings } from "./settings.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { BoardManager } from "./board.ts"
import {
  slugify,
  resolveSlug,
  composePrompt,
  buildClaudeCommand,
  buildClaudeResumeCommand,
  fallbackTitle,
  scratchpadOrientation,
  createDispatcher,
} from "./dispatch.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend } from "./backend/codex.ts"
import type { CodexAppServerBridge } from "./backend/codex-app-server.ts"
import type { ClaudeAgentBrokerBridge } from "./backend/claude-agent-broker-bridge.ts"
import type { AgentBackend } from "./backend/types.ts"
import type { PaneIdentity } from "./adoption-recovery.ts"

function tmp(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakePaneIdentity(n = 1): PaneIdentity {
  return { paneId: `%${n}`, panePid: 10_000 + n, sessionCreated: 20_000 + n }
}

// A dispatcher wired to a tmp project + real storage + a stub board + injected spawn seams. No test in
// this harness contacts the live project socket or starts a real worker.
function dispatcherHarness(settings = defaultSettings()) {
  const dir = tmp("frizz-dispatch-")
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "id", name: "test", label: "o/test", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const spawned: { slug: string; cmd: string[]; cwd: string; env?: Record<string, string>; promptText?: string; promptMode?: number }[] = []
  const board: BoardManager = {
    snapshot: async () => ({}) as never,
    currentSeq: () => 0,
    rebuild: async () => ({}) as never,
    refresh: () => ({}) as never,
    start: async () => {},
    stop: async () => {},
  }
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    readBoard: async () => ({
      config: {},
      threads: existsSync(join(dir, ".frizz"))
        ? readdirSync(join(dir, ".frizz"), { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => ({
              id: entry.name.slice(0, -3),
              title: entry.name.slice(0, -3),
              status: "active",
              owner: null,
              agents: [],
              errors: [],
              warnings: [],
            }))
        : [],
      errors: [],
      warnings: [],
      errorItems: [],
    }),
    getSettings: () => settings,
    // The broker is the only claude transport now, so what a dispatch "carries" lives in the
    // spawnDispatch input rather than in a spawned argv. `cmd` keeps the prompt + system prompt so the
    // assertions below still read the same facts.
    claudeBroker: {
      spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; prompt: string; appendSystemPrompt?: string }) => {
        spawned.push({ slug: input.threadSlug, cmd: [input.appendSystemPrompt ?? "", input.prompt], cwd: input.cwd, env: { FRIZZ_THREAD: input.threadSlug } })
        return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
      },
      releaseSession: () => {},
    } as unknown as ClaudeAgentBrokerBridge,
  })
  return { dir, storage, project, spawned, dispatcher }
}

// The system prompt a spawn carries. It rides `--append-system-prompt-file <path>` (inline text
// would blow the OS command-length limit), so resolve the path and read the file. Falls back to a
// legacy inline `--append-system-prompt <text>` if present. "" when neither is set.
// Two shapes. `buildClaudeCommand` still produces a real argv (resume uses it), where the system
// prompt rides `--append-system-prompt[-file]`. A DISPATCH has no argv at all — the broker takes the
// system prompt as a string — so the harness records it first, mirroring where the argv put it.
function systemPromptOf(cmd: string[]): string {
  const fi = cmd.indexOf("--append-system-prompt-file")
  if (fi !== -1) {
    try {
      return readFileSync(cmd[fi + 1], "utf8")
    } catch {
      return ""
    }
  }
  const i = cmd.indexOf("--append-system-prompt")
  if (i !== -1) return cmd[i + 1]
  return cmd[0] ?? ""
}

test("storage: session roundtrip + markRead + exited", () => {
  const dir = tmp("frizz-store-")
  const s = createStorage(join(dir, "ui.db"), "p")
  assert.equal(s.getSession("t"), undefined)

  s.upsertSession({
    slug: "t",
    session_id: "sid-1",
    thread_name: "frizz-t",
    spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null,
    unread: 1,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: "open",
    meta: null,
    seen_at: null,
    transcript_id: null,
  })
  let row = s.getSession("t")
  assert.equal(row?.session_id, "sid-1")
  assert.equal(row?.unread, 1)
  assert.equal(s.allSessions().length, 1)

  s.markRead("t", "2026-07-01T01:00:00.000Z")
  row = s.getSession("t")
  assert.equal(row?.unread, 0)
  assert.equal(row?.last_read_at, "2026-07-01T01:00:00.000Z")

  s.setExited("t", true)
  assert.equal(s.getSession("t")?.exited, 1)

  // upsert is idempotent on the slug PK
  s.upsertSession({ ...row!, session_id: "sid-2", unread: 1, exited: 0 })
  assert.equal(s.allSessions().length, 1)
  assert.equal(s.getSession("t")?.session_id, "sid-2")
  s.close()
})

test("storage: transcript_id cache round-trips, survives restart, resets on re-dispatch, preserves on resume", () => {
  const dir = tmp("frizz-store-tid-")
  const dbPath = join(dir, "ui.db")
  const s = createStorage(dbPath, "p")
  s.upsertSession({
    slug: "t", session_id: "sid-1", thread_name: "frizz-t", spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  // The tailer's discovery caches the drifted transcript's id.
  s.setTranscriptId("t", "forked-id")
  assert.equal(s.getSession("t")?.transcript_id, "forked-id")
  s.close()

  // Survives a server restart (persisted to disk, read back on reopen).
  const s2 = createStorage(dbPath, "p")
  assert.equal(s2.getSession("t")?.transcript_id, "forked-id", "the cached id persists across restart")

  // A RESUME spreads the existing row (same session_id) → the cached discovery is preserved.
  const row = s2.getSession("t")!
  s2.upsertSession({ ...row, spawned_at: "2026-07-01T01:00:00.000Z", exited: 0 })
  assert.equal(s2.getSession("t")?.transcript_id, "forked-id", "resume preserves the cache")

  // A RE-DISPATCH/ADOPT carries a FRESH session_id + transcript_id:null → the stale cache is cleared.
  s2.upsertSession({ ...row, session_id: "sid-2", transcript_id: null })
  assert.equal(s2.getSession("t")?.transcript_id ?? null, null, "a fresh session_id resets the cache")
  s2.close()
})

test("settings: defaults, roundtrip, merge-over-defaults", () => {
  const dir = tmp("frizz-settings-")
  const s = createStorage(join(dir, "ui.db"), "p")
  // The tmp dir doubles as the home: machine settings are real files, and a test that reads the
  // developer own ~/.frizz would both leak into its assertions and write to it.
  const def = getSettings(s, dir)
  assert.deepEqual(def, defaultSettings())
  // Project-specific conventions live in FRIZZ.md, not in settings — there is no preamble field.
  // system prompt ships separately (packages/server/src/workerPrompt.ts via dispatch.ts) and is not a setting.
  assert.equal(def.permissionMode, "bypassPermissions")
  assert.equal(def.notifications, true)

  setSettings(s, { ...def, permissionMode: "plan", model: "opus", notifications: false }, dir)
  const got = getSettings(s, dir)
  assert.equal(got.permissionMode, "plan")
  assert.equal(got.model, "opus")
  assert.equal(got.notifications, false)
  s.close()
})

test("slugify: normalizes titles to the board id regex", () => {
  const re = /^[a-z0-9][a-z0-9-]*$/
  assert.equal(slugify("Fix the Board!"), "fix-the-board")
  assert.equal(slugify("  Multiple   spaces  "), "multiple-spaces")
  assert.equal(slugify("CamelCase & Symbols #1"), "camelcase-symbols-1")
  assert.match(slugify("Ünïcödé weird"), re)
  assert.equal(slugify("!!!"), "thread")
})

test("fallbackTitle: never ends mid-phrase and drops topic-free lead-ins", () => {
  // The exact garbage case ("also-spin-up-a-sub-agent-to"): "also" stripped, the 6-word window
  // lands on "to", and the trail backoff drops it.
  assert.equal(fallbackTitle("also spin up a sub agent to review the docs"), "spin up a sub agent…")
  // Window landing on an article backs off as well.
  assert.equal(fallbackTitle("please fix the bug found in the parser module"), "fix the bug found…")
  // Never trims below two words.
  assert.equal(fallbackTitle("fix the"), "fix the")
})

test("fallbackTitle: first ~6 words of the first line, capped + ellipsized", () => {
  // short prompt: whole thing, no ellipsis
  assert.equal(fallbackTitle("Fix the board parser"), "Fix the board parser")
  // >6 words → first 6 + ellipsis
  assert.equal(fallbackTitle("one two three four five six seven eight"), "one two three four five six…")
  // only the first line is considered
  assert.equal(fallbackTitle("Investigate the flake\nthen write it up"), "Investigate the flake")
  // leading/trailing whitespace trimmed
  assert.equal(fallbackTitle("   Refactor tailer   "), "Refactor tailer")
  // 48-char cap even within 6 words (single long token)
  const long = fallbackTitle("supercalifragilisticexpialidocioussupercalifragilistic tail")
  assert.ok(long.length <= 48)
  assert.ok(long.endsWith("…"))
  // empty / whitespace-only → the "thread" sentinel (never empty; slug needs it)
  assert.equal(fallbackTitle("   "), "thread")
})

test("fallbackTitle: derived title slugifies to a valid board id", () => {
  const re = /^[a-z0-9][a-z0-9-]*$/
  assert.match(slugify(fallbackTitle("Fix the board parser bug now please")), re)
  assert.match(slugify(fallbackTitle("!!! ???")), re) // slugify falls back to "thread"
  assert.equal(slugify(fallbackTitle("one two three four five six seven")), "one-two-three-four-five-six")
})

test("resolveSlug: appends -N on collision", () => {
  const dir = tmp("frizz-slug-")
  const frizzDir = join(dir, ".frizz")
  mkdirSync(frizzDir, { recursive: true })
  assert.equal(resolveSlug(frizzDir, "foo"), "foo")

  writeFileSync(join(frizzDir, "foo.md"), "x")
  assert.equal(resolveSlug(frizzDir, "foo"), "foo-2")

  writeFileSync(join(frizzDir, "foo-2.md"), "x")
  assert.equal(resolveSlug(frizzDir, "foo"), "foo-3")

  // A taken REGISTRY slug (a fileless session dispatch) also bumps — uniqueness spans rows, not just files.
  const taken = new Set(["bar", "bar-2"])
  assert.equal(resolveSlug(frizzDir, "bar", (s) => taken.has(s)), "bar-3")
  assert.equal(resolveSlug(frizzDir, "baz", (s) => taken.has(s)), "baz")
})

test("composePrompt: scratch-directory orientation + task, and NOT the operator's instructions", () => {
  const out = composePrompt("sid-123", "Do the thing.")
  // Session-first: the visible first message points at the scratch DIRECTORY, NOT a .frizz file to own.
  // The fixed worker prompt still rides --append-system-prompt (buildClaudeCommand), not this message.
  assert.ok(out.includes(".frizz/threads/sid-123/"))
  assert.ok(!out.includes("scratch.md"), "no filename is reserved in that directory")
  assert.ok(!out.includes("You are a dispatched worker agent"))
  assert.ok(!out.includes("You own")) // the old ownership contract is gone
  assert.ok(!out.includes("status: blocked"))
  // There is no operator preamble anywhere any more — project conventions live in FRIZZ.md alone.
  assert.ok(!out.includes("PROJECT INSTRUCTIONS"))
  assert.ok(out.endsWith("\n\nDo the thing.")) // the task is the tail, directly below the banner
})

test("scratchpadOrientation: names the scratch directory", () => {
  const bare = scratchpadOrientation("sid-1")
  assert.ok(bare.includes("SCRATCH DIRECTORY: .frizz/threads/sid-1/"))
})

test("buildClaudeCommand: pins session-id, permission mode, optional model/effort, worker system prompt", () => {
  const base = buildClaudeCommand({
    sessionId: "uuid-1",
    permissionMode: "acceptEdits",
    prompt: "hello",
    claudeBin: "sleep",
    workerPrompt: "", // disabled for the argv-shape assertion
  })
  // NO --mcp-config / --allowedTools here: these dispatches carry no frizz-MCP descriptor and no project
  // servers, and frizz mounts nothing else (the always-on chrome-devtools mount was removed 2026-08-26 —
  // dispatch.ts). Empty flags would be worse than absent ones, so claudeMcpFlags emits neither. What it
  // ALWAYS emits is `--strict-mcp-config` (since 2026-09-03): with nothing to mount, the CLI must still
  // not discover the operator's user-scope servers. dispatch.test.ts pins that; this pins the argv
  // POSITION the MCP flags occupy — right before the disallowed-tools flag.
  const TAIL_FLAGS = ["--strict-mcp-config", "--disallowedTools=AskUserQuestion"]
  assert.deepEqual(base, ["sleep", "--session-id", "uuid-1", "--permission-mode", "acceptEdits", ...TAIL_FLAGS, "hello"])

  const full = buildClaudeCommand({
    sessionId: "uuid-2",
    permissionMode: "acceptEdits",
    model: "opus",
    effort: "high",
    prompt: "go",
    workerPrompt: "WORKER_NORMS",
  })
  // The worker norms ride --append-system-prompt-file (a path), not inline text — inline would blow
  // the OS command-length limit. Assert the fixed head, the file-flag, the file CONTENT, and the
  // trailing prompt.
  assert.deepEqual(full.slice(0, 9), [
    "claude",
    "--session-id",
    "uuid-2",
    "--permission-mode",
    "acceptEdits",
    "--model",
    "opus",
    "--effort",
    "high",
  ])
  // After the fixed head come the MCP flag and the disallowed-tools flag, then the system-prompt file flag.
  assert.deepEqual(full.slice(9, 9 + TAIL_FLAGS.length), TAIL_FLAGS)
  assert.equal(full[9 + TAIL_FLAGS.length], "--append-system-prompt-file")
  assert.equal(systemPromptOf(full), "WORKER_NORMS")
  assert.equal(full[full.length - 1], "go")

  // A worker is NEVER spawned in interactive plan mode (no coherent headless semantics + softlock):
  // `plan` is coerced to the safe default `auto` in the argv, on both dispatch and resume.
  const planned = buildClaudeCommand({ sessionId: "u", permissionMode: "plan", prompt: "p", workerPrompt: "" })
  assert.deepEqual(planned, ["claude", "--session-id", "u", "--permission-mode", "auto", ...TAIL_FLAGS, "p"])
  const rplan = buildClaudeResumeCommand({ sessionId: "s", permissionMode: "plan", message: "m", workerPrompt: "" })
  assert.deepEqual(rplan, ["claude", "--permission-mode", "auto", ...TAIL_FLAGS, "-r", "s", "m"])

  // Default (no injection): the shipped WORKER_PROMPT.md rides --append-system-prompt-file.
  const dflt = buildClaudeCommand({ sessionId: "u", permissionMode: "auto", prompt: "p" })
  assert.ok(dflt.includes("--append-system-prompt-file"))
  assert.ok(systemPromptOf(dflt).startsWith("You are a dispatched worker agent"))
})

test("buildClaudeResumeCommand: -r <sessionId> with the follow-up + worker system prompt", () => {
  const cmd = buildClaudeResumeCommand({ sessionId: "sid", permissionMode: "acceptEdits", message: "more", workerPrompt: "" })
  assert.deepEqual(cmd, ["claude", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--disallowedTools=AskUserQuestion", "-r", "sid", "more"])
  // Resume re-carries the worker norms (system prompt is rebuilt per invocation) via the file flag.
  const dflt = buildClaudeResumeCommand({ sessionId: "sid", permissionMode: "auto", message: "m" })
  assert.ok(dflt.includes("--append-system-prompt-file"))
  const system = systemPromptOf(dflt)
  assert.ok(system.startsWith("You are a dispatched worker agent"))
  // A dead-session follow-up rebuilds the system prompt, so the awaiting re-entry invariant must ride
  // the ACTUAL `claude -r` invocation—not live only in a companion skill the worker may not reload.
  // Whitespace-normalized: pin the RULE, not the line-wrap.
  const flat = system.replace(/\s+/g, " ")
  assert.match(flat, /back to awaiting/)
  assert.match(flat, /never answer that it is already parked/)
  assert.match(flat, /emit a FRESH fence/)
})

test("build*Command: extraSystemPrompt is appended AFTER the worker norms in the system prompt", () => {
  const scratch = "SCRATCHPAD: .frizz/threads/u/scratch.md — memory"
  const disp = buildClaudeCommand({ sessionId: "u", permissionMode: "auto", prompt: "p", workerPrompt: "WORKER", extraSystemPrompt: scratch })
  const dSys = systemPromptOf(disp)
  assert.ok(dSys.startsWith("WORKER"))
  assert.ok(dSys.includes(scratch))
  // Same seam on resume — the scratchpad orientation must survive a session bounce.
  const res = buildClaudeResumeCommand({ sessionId: "s", permissionMode: "auto", message: "m", workerPrompt: "WORKER", extraSystemPrompt: scratch })
  const rSys = systemPromptOf(res)
  assert.ok(rSys.startsWith("WORKER"))
  assert.ok(rSys.includes(scratch))
})

test("dispatch: creates an EMPTY scratch dir (not a thread file), argv carries it, stores an open row", async () => {
  const h = dispatcherHarness()
  const { slug, sessionId } = await h.dispatcher.dispatch({ prompt: "Do the thing.", model: "opus", effort: "high" })

  // Session-first: NO .frizz/<slug>.md thread file is written on dispatch.
  assert.ok(!existsSync(join(h.dir, ".frizz", `${slug}.md`)), "no thread file written")

  // The scratch DIRECTORY is provisioned, and provisioned EMPTY. Nothing is seeded into it: the
  // skeleton went away with the canonical pad (2026-08-06), and a template the worker did not write is
  // exactly what used to make "present" indistinguishable from "written".
  const scratchDir = join(h.dir, ".frizz", "threads", sessionId)
  assert.ok(existsSync(scratchDir), "scratch directory created")
  assert.deepEqual(readdirSync(scratchDir), [], "nothing is provisioned inside it")

  // argv: the SCRATCH orientation rides the system prompt; the user message carries the path + TASK
  // and NONE of the retired thread-ownership contract.
  const cmd = h.spawned[0].cmd
  assert.ok(systemPromptOf(cmd).includes(`SCRATCH DIRECTORY: .frizz/threads/${sessionId}/`))
  const userPrompt = cmd[cmd.length - 1]
  assert.ok(userPrompt.includes(`.frizz/threads/${sessionId}/`))
  assert.ok(userPrompt.endsWith("\n\nDo the thing.")) // the task is the tail, directly below the banner
  assert.ok(!userPrompt.includes("You own"))
  assert.equal(h.spawned[0].env?.FRIZZ_THREAD, slug)

  const row = h.storage.getSession(slug)
  assert.equal(row?.session_id, sessionId)
  assert.equal(row?.state, "open")
  assert.equal(row?.model, "opus", "the dispatch model is pinned on the session row")
  assert.equal(row?.effort, "high", "the dispatch effort is pinned on the session row")
  assert.equal(row?.permission_mode, "bypassPermissions", "the concrete launch permission is pinned on the session row")
})

test("adopt: requires the legacy file, provisions a scratch dir, orientation is context-not-contract", async () => {
  const h = dispatcherHarness({ ...defaultSettings(), model: "sonnet", effort: "xhigh" })
  // No file → clean rejection.
  await assert.rejects(h.dispatcher.adopt("adopt-fixture"), /thread is not available for adoption/)

  mkdirSync(join(h.dir, ".frizz"), { recursive: true })
  writeFileSync(join(h.dir, ".frizz", "adopt-fixture.md"), "---\ntitle: x\nstatus: active\n---\n\n## Goal\n\ng\n")
  const { slug, sessionId } = await h.dispatcher.adopt("adopt-fixture", "keep going")
  assert.equal(slug, "adopt-fixture")

  // A scratch directory is provisioned even for an adopted thread.
  assert.ok(existsSync(join(h.dir, ".frizz", "threads", sessionId)))

  // System prompt: scratch orientation + the adoption note framing the file as CONTEXT, not a contract.
  const sys = systemPromptOf(h.spawned[0].cmd)
  assert.ok(sys.includes(`SCRATCH DIRECTORY: .frizz/threads/${sessionId}/`))
  assert.ok(sys.includes("CONTEXT, not a contract"))
  assert.ok(sys.includes("adopt-fixture.md"))
  const row = h.storage.getSession(slug)
  assert.equal(row?.model, "sonnet", "adoption pins the model default used for its new session")
  assert.equal(row?.effort, "xhigh", "adoption pins the effort default used for its new session")
  assert.equal(row?.permission_mode, "bypassPermissions", "adoption pins the concrete launch permission")
})

test("cwdSlug: replaces every non-alphanumeric character with - (Claude Code project-log convention)", () => {
  assert.equal(cwdSlug("/Users/x/Documents/projects/frizz"), "-Users-x-Documents-projects-frizz")
  assert.equal(cwdSlug("/Users/x/.workshell/wt"), "-Users-x--workshell-wt")
})

// ---- Codex dispatch wiring (Codex-support epic, Phase 2): the COMPOSED spawn orchestration ----
// createCodexBackend + createClaudeBackend behind a backendFor resolver (mirrors context.ts). A codex
// dispatch must: pre-arm the cwd trust gate, spawn the codex argv (worker contract in the prompt), then
// sentinel-discover the rollout id and PIN it on the row (session_id stays the frizz key). A claude
// dispatch through the SAME dispatcher is byte-identical — no trust write, backend stays 'claude'.
function codexDispatcherHarness(codexAppServer?: Partial<CodexAppServerBridge>) {
  const dir = tmp("frizz-dispatch-codex-")
  const codexHome = tmp("frizz-codexhome-")
  const storage = createStorage(join(dir, "ui.db"), "p")
  const project: Project = { dir, id: "id", name: "test", label: "o/test", stateDir: dir, cwdSlug: cwdSlug(dir) }
  const spawned: {
    slug: string
    cmd: string[]
    cwd: string
    env?: Record<string, string>
    promptText?: string
    promptMode?: number
  }[] = []
  const CODEX_ID = "019f4e0a-cafe-7891-9cbf-00000000abcd"
  // A spawn that SIMULATES codex: extract the per-dispatch sentinel from the prompt (codex spawns via an
  // `sh -c` wrapper that reads the prompt from a temp FILE — the last argv element — so read it) and write
  // a fresh rollout carrying it (+ a session_meta id/cwd) so the dispatcher's sentinel discovery resolves
  // it. A claude spawn (no `frizz-session:` sentinel) writes nothing — the resolver stayed off codex.
  const spawn = (slug: string, cmd: string[], cwd: string, env?: Record<string, string>) => {
    const last = cmd[cmd.length - 1] ?? ""
    const promptText = cmd[0] === "sh" ? readFileSync(last, "utf8") : last
    const promptMode = cmd[0] === "sh" ? statSync(last).mode & 0o777 : undefined
    spawned.push({ slug, cmd, cwd, env, promptText, promptMode })
    const sentinel = promptText.match(/frizz-session:[0-9a-f-]+/)?.[0]
    if (!sentinel) return fakePaneIdentity(spawned.length)
    const sdir = join(codexHome, "sessions", "2026", "07", "10")
    mkdirSync(sdir, { recursive: true })
    const meta = JSON.stringify({ timestamp: "2026-07-10T22:00:00.000Z", type: "session_meta", payload: { session_id: CODEX_ID, cwd } })
    const um = JSON.stringify({ timestamp: "2026-07-10T22:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: `do the task <!-- ${sentinel} -->` } })
    writeFileSync(join(sdir, `rollout-2026-07-10T22-00-00-${CODEX_ID}.jsonl`), meta + "\n" + um + "\n")
    return fakePaneIdentity(spawned.length)
  }
  const codexBackend = createCodexBackend({ codexHome })
  const claudeBackend = createClaudeBackend({ logDir: join(dir, "logs") })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  const board: BoardManager = {
    snapshot: async () => ({}) as never,
    currentSeq: () => 0,
    rebuild: async () => ({}) as never,
    refresh: () => ({}) as never,
    start: async () => {},
    stop: async () => {},
  }
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => defaultSettings(),
    backendFor,
    claudeBroker: {
      spawnDispatch: async (input: { threadSlug: string; sessionId: string; cwd: string; prompt: string; appendSystemPrompt?: string }) => {
        spawned.push({ slug: input.threadSlug, cmd: [input.appendSystemPrompt ?? "", input.prompt], cwd: input.cwd, env: {} })
        return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd } }
      },
      releaseSession: () => {},
    } as unknown as ClaudeAgentBrokerBridge,
    codexAppServer: codexAppServer as CodexAppServerBridge | undefined,
  })
  return { dir, codexHome, storage, project, spawned, dispatcher, CODEX_ID }
}

test("dispatch(codex): a failing app-server bridge throws loudly — there is NO TUI fallback (retired)", async () => {
  let released = 0
  const h = codexDispatcherHarness({
    spawnDispatch: async () => { throw new Error("app-server unavailable (protocol drift)") },
    releaseSession: () => { released++; return true },
  })
  await assert.rejects(
    h.dispatcher.dispatch({ prompt: "No fallback." }, { backend: "codex" }),
    /Codex app-server could not start this thread/,
  )
  assert.equal(h.spawned.length, 0, "no spawn at all — the TUI path is retired")
  assert.equal(released, 1, "the partial bridge binding was released")
  // Assert on the REGISTRY, not a guessed slug: dispatch throws before any upsertSession, so a
  // slug-keyed lookup would pass even if it were aimed at the wrong row.
  assert.equal(h.storage.allSessions().length, 0, "a failed dispatch leaves no row")
})

test("dispatch(claude) through the same resolver is UNCHANGED — no trust write, backend stays claude", async () => {
  const h = codexDispatcherHarness()
  const { slug } = await h.dispatcher.dispatch({ prompt: "Business as usual." }) // no opts → claude

  assert.ok(!existsSync(join(h.codexHome, "config.toml")), "a claude dispatch never touches the codex trust config")
  const rowdb = h.storage.getSession(slug)!
  assert.equal(rowdb.backend, "claude", "backend stays the column default")
  assert.equal(rowdb.agent_session_id ?? null, null, "no codex rollout id pinned")
  assert.match(h.spawned[0].cmd[1], /Business as usual/, "the claude dispatch reached the broker with its prompt")
})
