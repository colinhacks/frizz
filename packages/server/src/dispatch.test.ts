import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DISPATCH_TASK_BANNER_MARKER } from "@frizz/shared"
import { acpWorkerContract, buildClaudeCommand, claudeContractOptions, claudeWorkerSystemPrompt, codexWorkerBaseInstructions, opencodeWorkerContract, launchableWorkerPluginDir, loadWorkerPrompt, composePrompt, monitorScriptsDir, resolveWorkerPluginDir, scratchpadOrientation, workerPluginDir, frizzConfigBlock, workerDispatchPermission, WORKER_DISPATCH_PERMISSION } from "./dispatch.ts"
import { parseTranscript } from "./transcript.ts"
import { FRIZZ_MCP } from "./backend/types.ts"

// The worker's MCP config, read from the owner-only FILE its argv names. Never inline JSON: the config
// carries credentials, and an argv is readable through `ps` by every local process.
function mcpConfigOf(argv: string[]) {
  const path = argv[argv.indexOf("--mcp-config") + 1]
  assert.ok(path && isAbsolute(path), `--mcp-config must name a file: ${path}`)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  return JSON.parse(readFileSync(path, "utf8"))
}

// ---- Backend-aware worker contract (worker-contract-backend-aware) ----
// loadWorkerPrompt(kind) delegates to buildWorkerPrompt in workerPrompt.ts (a single compiled-in TS
// source, no runtime markdown/marker fill). The CLAUDE output must still reproduce the pre-split
// contract BYTE-FOR-BYTE (the regression bar); the CODEX output has its own golden.

const here = dirname(fileURLToPath(import.meta.url))
// The FROZEN pre-split claude contract body (the exact string a claude dispatch got before the split).
// Regenerate ONLY when the shipped claude contract is deliberately changed — an unexpected diff here is
// a regression (a core/claude-fragment edit that altered what a claude worker receives).
// The markdown loader trims the contract body; normalize the fixture's conventional POSIX newline
// before making the byte-for-byte comparison of the actual prompt content.
const CLAUDE_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.claude.golden.txt"), "utf8").trimEnd()
const CLAUDE_BYPASS_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.claude.bypass.golden.txt"), "utf8").trimEnd()
const CODEX_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.codex.golden.txt"), "utf8").trimEnd()
const SESSION_SEED = readFileSync(join(here, "../../../cc-worker/hooks/session-seed.mjs"), "utf8")

test("loadWorkerPrompt: default kind is claude", () => {
  assert.equal(loadWorkerPrompt(), loadWorkerPrompt("claude"))
})

test("Claude dispatch supplies the discovered worker plugin via --plugin-dir", () => {
  const plugin = workerPluginDir()
  assert.ok(plugin, "the packaged worker plugin must be discoverable")
  assert.doesNotThrow(() => readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"))
  const argv = buildClaudeCommand({
    sessionId: "plugin-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    pluginDir: plugin,
  })
  assert.deepEqual(argv.slice(argv.indexOf("--plugin-dir"), argv.indexOf("--plugin-dir") + 2), ["--plugin-dir", plugin])
})

test("Claude dispatch mounts the unified frizz MCP server, alone, and pre-approves it", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    frizzMcp: { scriptPath: "/abs/plugin/bin/frizz-mcp.mjs", stateDir: "/home/.frizz/projects/pid" },
  })
  const cfg = mcpConfigOf(argv)
  // `frizz` is the ONLY server frizz injects. A `chrome-devtools` mount rode every dispatch until
  // 2026-08-26; it cost ~6,400 prefix tokens of tool schema on a worker that mostly never opened a
  // page, and a browser is the project's to bring — its `.mcp.json`, which rides this same config file
  // (next test but one); `claude mcp add --scope user` no longer reaches a worker at all.
  assert.ok(argv.includes("--strict-mcp-config"), "a worker discovers no MCP scope on its own")
  assert.deepEqual(Object.keys(cfg.mcpServers), [FRIZZ_MCP.name])
  assert.deepEqual(cfg.mcpServers[FRIZZ_MCP.name], {
    command: process.execPath, // absolute node path, not bare "node" (worker PATH-independence)
    args: ["/abs/plugin/bin/frizz-mcp.mjs"],
    env: { FRIZZ_STATE_DIR: "/home/.frizz/projects/pid" },
  })
  // No FRIZZ_PROJECT_ID here because this descriptor carries none: the id is stamped by the SERVER at
  // spawn, from the worker's own project, and is never a tool argument — which is what makes "spawn a
  // thread on another project's board" unexpressible rather than merely discouraged. The same reason
  // FRIZZ_THREAD_SLUG is env-only.
  // Tools are pre-approved so a headless worker never blocks on a permission prompt. One comma-joined
  // EQUALS-form token: --allowedTools is variadic, so a space-separated value could swallow a
  // following positional (the prompt) — the equals form binds exactly one token. BOTH rules are
  // SERVER-level, so a tool added to either server needs no allow-list edit.
  assert.ok(argv.includes("--allowedTools=mcp__frizz"))
  // Nothing in the argv reaches for a browser, on any flag.
  assert.ok(!argv.some((a) => a.includes("chrome-devtools")), "frizz must inject no browser")
  // The prompt stays the trailing positional (flags never displace it).
  assert.equal(argv[argv.length - 1], "test")
})

test("Claude dispatch stamps the singleton's lock path and the worker's OWN project into the frizz MCP env", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-tenant",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    frizzMcp: {
      scriptPath: "/abs/plugin/bin/frizz-mcp.mjs",
      stateDir: "/home/.frizz/projects/tenant",
      serverLock: "/home/.frizz/projects/launcher/server.lock",
      projectId: "b47f4055-4262-432a-af18-ded4cbfb3071",
    },
  })
  const cfg = mcpConfigOf(argv)
  // One process serves N projects and writes ONE lock (the launcher's), so a tenant's worker is told
  // where that lock is; and the RPC it POSTs is prefixed with its own project, because unprefixed
  // means the LAUNCHING project — the difference between spawning onto your board and onto someone
  // else's. Neither value is derivable inside the worker, and neither is a tool argument.
  assert.deepEqual(cfg.mcpServers[FRIZZ_MCP.name].env, {
    FRIZZ_STATE_DIR: "/home/.frizz/projects/tenant",
    FRIZZ_SERVER_LOCK: "/home/.frizz/projects/launcher/server.lock",
    FRIZZ_PROJECT_ID: "b47f4055-4262-432a-af18-ded4cbfb3071",
  })
})

test("Claude dispatch mounts NOTHING when no frizz-MCP descriptor resolved — no empty flags", () => {
  const argv = buildClaudeCommand({ sessionId: "no-mcp", permissionMode: "auto", prompt: "test", workerPrompt: "" })
  // With the browser mount gone this is a real state, and the flags must be ABSENT rather than empty:
  // `--allowedTools=` hands the CLI one rule that is the empty string, which is not the same as no
  // rule at all. `--strict-mcp-config` is the one flag that stays: it is what keeps the operator's
  // user-scope servers out of the worker, and a worker with nothing to mount still must not boot them
  // (the project's own `.mcp.json` arrives through `projectMcpServers`, never through discovery).
  assert.ok(argv.includes("--strict-mcp-config"))
  assert.ok(!argv.includes("--mcp-config"))
  assert.ok(!argv.some((a) => a.startsWith("--allowedTools")))
})

test("Claude dispatch mounts the project's approved servers under --strict-mcp-config, and frizz wins a name collision", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-project",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    frizzMcp: { scriptPath: "/abs/plugin/bin/frizz-mcp.mjs", stateDir: "/home/.frizz/projects/pid" },
    projectMcpServers: {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@1.7.0", "--headless"] },
      Neon: { type: "http", url: "https://mcp.neon.tech/mcp" },
      [FRIZZ_MCP.name]: { command: "/not/frizz" },
    },
  })
  assert.ok(argv.includes("--strict-mcp-config"))
  const cfg = mcpConfigOf(argv)
  // The project's servers travel in the SAME config file as the frizz mount — under strict mode that
  // config is the whole MCP surface — and a project cannot shadow `frizz` by naming a server after it.
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["Neon", "chrome-devtools", FRIZZ_MCP.name].sort())
  assert.deepEqual(cfg.mcpServers["chrome-devtools"], { command: "npx", args: ["-y", "chrome-devtools-mcp@1.7.0", "--headless"] })
  assert.deepEqual(cfg.mcpServers.Neon, { type: "http", url: "https://mcp.neon.tech/mcp" })
  assert.equal(cfg.mcpServers[FRIZZ_MCP.name].args[0], "/abs/plugin/bin/frizz-mcp.mjs")
  // Only the frizz server is pre-approved; a project server keeps whatever approval story it had.
  assert.ok(argv.includes("--allowedTools=mcp__frizz"))
})

test("Claude worker surfaces share the canonical per-session scratch DIRECTORY path", () => {
  const sessionId = "scratch-canonical"
  const canonical = `.frizz/threads/${sessionId}/`
  assert.match(composePrompt(sessionId, "task", "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(scratchpadOrientation(sessionId, "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(SESSION_SEED, /\.frizz\/threads\//)
  // No surface may resurrect the canonical filename: nothing reserves a name in that directory now.
  assert.doesNotMatch(composePrompt(sessionId, "task", "claude"), /scratch\.md/)
  assert.doesNotMatch(scratchpadOrientation(sessionId, "claude"), /scratch\.md/)
  assert.doesNotMatch(SESSION_SEED, /scratch\.md/)
  assert.doesNotMatch(SESSION_SEED, /\.frizz\/scratch\//)
})

// ---- FRIZZ.md project-config injection (defer-to-project-norms) ----
// A repo-committed FRIZZ.md at the project root is injected into the worker SYSTEM prompt under an
// "overrides frizz defaults" header, so a project's own norms win over frizz's built-in defaults.
test("frizzConfigBlock: absent FRIZZ.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-absent-"))
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock: empty/whitespace FRIZZ.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-empty-"))
  writeFileSync(join(dir, "FRIZZ.md"), "\n  \n")
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock: present FRIZZ.md is wrapped in an overrides-frizz-defaults header", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-present-"))
  const body = "## Our norms\n- Gates: `pnpm check`\n- Skip adversarial review on small UI diffs."
  writeFileSync(join(dir, "FRIZZ.md"), body + "\n")
  const block = frizzConfigBlock(dir)
  assert.match(block, /PROJECT FRIZZ CONFIG \(from this repo's FRIZZ\.md\)/)
  // Header is scoped to PROCESS defaults and explicitly does NOT relax the frizz-mechanical contract —
  // so a FRIZZ.md can't contradict the "Defer" section's non-negotiable browser/signal gates.
  assert.match(block, /OVERRIDE the frizz worker PROCESS defaults above/)
  assert.match(block, /do NOT relax the frizz-mechanical contract/)
  assert.ok(block.includes(body), "the FRIZZ.md body must be present verbatim")
})

test("frizzConfigBlock: an over-cap FRIZZ.md content is clipped with a truncation marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-clip-"))
  writeFileSync(join(dir, "FRIZZ.md"), "x".repeat(50_000)) // > 24k chars, < 64KB → read then clipped
  const block = frizzConfigBlock(dir)
  assert.match(block, /\[FRIZZ\.md truncated\]/)
  assert.ok(block.length < 26_000, "the injected block must stay within the system-prompt budget")
})

// THE CAP HAS TO CLEAR A REAL FILE, not just look prudent, and the clip is silent to everyone who
// matters: the marker lands in a system prompt nobody reads. At 12,000 this repo's own FRIZZ.md
// (16,522 chars on 2026-08-28) lost its last 4,522 on EVERY dispatch — beginning at the "NEVER open a
// pull request" section, which CLAUDE.md calls the most-violated rule in the repo. This test is the
// guard; the constant is only a number.
test("frizzConfigBlock injects this repo's own FRIZZ.md IN FULL — the cap clears the real file", () => {
  const repoRoot = join(here, "..", "..", "..")
  const body = readFileSync(join(repoRoot, "FRIZZ.md"), "utf8").trim()
  const block = frizzConfigBlock(repoRoot)
  assert.doesNotMatch(
    block,
    /\[FRIZZ\.md truncated\]/,
    `FRIZZ.md is ${body.length} chars and no longer fits the injection cap — raise FRIZZ_MD_MAX_CHARS or trim the file, because workers are silently losing its tail`,
  )
  assert.ok(block.includes(body), "the whole file must reach the worker, never a prefix of it")
})

test("frizzConfigBlock: a runaway (>64KB) FRIZZ.md is rejected unread, not slurped", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-runaway-"))
  writeFileSync(join(dir, "FRIZZ.md"), "x".repeat(200_000)) // exceeds the read-size guard
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock: a non-regular FRIZZ.md (a directory) injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-dir-"))
  mkdirSync(join(dir, "FRIZZ.md"))
  assert.equal(frizzConfigBlock(dir), "")
})

test("frizzConfigBlock composes AFTER the worker contract (override position) in the system prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-md-order-"))
  writeFileSync(join(dir, "FRIZZ.md"), "PROJECT-NORM-SENTINEL")
  for (const system of [claudeWorkerSystemPrompt(dir), codexWorkerBaseInstructions("frizz-md-order", dir)]) {
    assert.ok(system.indexOf("PROJECT-NORM-SENTINEL") > system.indexOf("Defer to the project's own norms"))
  }
})

// Claude Code sends the appended system prompt as one cached block, and a block is read from the cache
// only when every byte of it matches. With the thread's session id in it (the scratch line, until
// 2026-11-10) one line in 1,400 differed, and every thread's first call wrote the whole block afresh.
test("a Claude worker's system prompt names no session, so every thread of a project sends the same block", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-system-prompt-"))
  writeFileSync(join(dir, "FRIZZ.md"), "PROJECT-NORM-SENTINEL")
  const claude = claudeWorkerSystemPrompt(dir)
  assert.equal(claude, `${loadWorkerPrompt("claude")}\n\n${frizzConfigBlock(dir)}`, "the contract and FRIZZ.md, and nothing of one thread's")
  assert.doesNotMatch(claude, /SCRATCH DIRECTORY:/)
  assert.deepEqual([...claude.matchAll(/\.frizz\/threads\/([^/]+)\//g)].map((m) => m[1]), ["<session-id>"], "the one path it gives is the generic one")
  // …which sends the worker to where the real one is: what the SessionStart hooks inject (see
  // scratchpad-hook.test.ts, "both session-start hooks name the scratch directory").
  assert.match(claude, /exact path in your session-start context/)
  // No hook hands these backends the path when a session starts, so their system text keeps it.
  const others = { codex: codexWorkerBaseInstructions("sid-1", dir), acp: acpWorkerContract("sid-1", dir), opencode: opencodeWorkerContract("sid-1", dir) }
  for (const [kind, text] of Object.entries(others)) assert.match(text, /SCRATCH DIRECTORY: \.frizz\/threads\/sid-1\//, kind)
})

test("artifact worker resolver finds runtime/cc-worker through pnpm's nested module store", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-worker-plugin-resolver-"))
  const runtime = join(root, "runtime")
  const module = join(runtime, "node_modules", ".pnpm", "@frizz+server@fixture", "node_modules", "@frizz", "server", "src", "dispatch.js")
  const plugin = join(runtime, "cc-worker")
  mkdirSync(dirname(module), { recursive: true })
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
  writeFileSync(module, "export {}\n")
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}\n")
  assert.equal(resolveWorkerPluginDir(pathToFileURL(module).href, {}), plugin)
})

// ---- the path a worker is LAUNCHED against (launchableWorkerPluginDir) ----

/** A plugin as an artifact carries it: found at a version-specific path the launcher names, with the
 *  board it imports beside it (`runtime/board`, as scripts/prepare-package.mjs lays it out). */
function artifactPlugin(root: string, marker: string): string {
  const dir = join(root, "runtime", "cc-worker")
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true })
  mkdirSync(join(dir, "hooks"), { recursive: true })
  mkdirSync(join(root, "runtime", "board"), { recursive: true })
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}\n")
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ marker }))
  writeFileSync(join(root, "runtime", "board", "config.mjs"), `// ${marker}\n`)
  return dir
}

test("an artifact's plugin is launched through the stable path, and a newer artifact's boot moves it", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-launchable-plugin-"))
  const roots = { stageRoot: join(root, "cache", "plugins"), stableRoot: join(root, "cache", "current") }
  const marker = (path: string) => JSON.parse(readFileSync(join(path, "hooks", "hooks.json"), "utf8")).marker

  const v1 = artifactPlugin(join(root, "generation-1"), "v1")
  const launched = launchableWorkerPluginDir(v1, { FRIZZ_WORKER_PLUGIN_DIR: v1 }, roots)
  assert.equal(launched, join(roots.stableRoot, "cc-worker"), "a worker is handed the stable path, not the generation's own")
  assert.equal(marker(launched), "v1")

  // The next version boots: a different process in production, the same call here.
  const v2 = artifactPlugin(join(root, "generation-2"), "v2")
  assert.equal(launchableWorkerPluginDir(v2, { FRIZZ_WORKER_PLUGIN_DIR: v2 }, roots), launched, "the path a running worker holds never changes")
  assert.equal(marker(launched), "v2", "and what it leads to is now the new version's plugin")
  assert.equal(marker(v1), "v1", "with the old generation's own directory left exactly as it was")
})

test("a source checkout's plugin is launched where it stands — it is edited in place, so it is already live", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-launchable-plugin-"))
  const roots = { stageRoot: join(root, "cache", "plugins"), stableRoot: join(root, "cache", "current") }
  const checkout = artifactPlugin(root, "source")
  assert.equal(launchableWorkerPluginDir(checkout, {}, roots), checkout)
  assert.equal(existsSync(join(root, "cache")), false, "nothing was staged")
})

test("staging that fails costs no dispatch: the worker is launched against the immutable directory", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-launchable-plugin-"))
  const roots = { stageRoot: join(root, "cache", "plugins"), stableRoot: join(root, "cache", "current") }
  // Something real already sits where the link belongs, which ensureSymlink refuses to replace.
  mkdirSync(join(roots.stableRoot, "cc-worker"), { recursive: true })
  const artifact = artifactPlugin(join(root, "generation"), "v1")
  assert.equal(launchableWorkerPluginDir(artifact, { FRIZZ_WORKER_PLUGIN_DIR: artifact }, roots), artifact)
})

test("loadWorkerPrompt(claude) is BYTE-IDENTICAL to the pre-split contract (the regression bar)", () => {
  assert.equal(loadWorkerPrompt("claude"), CLAUDE_GOLDEN)
})

// A worker is told to register a server-run check only where the server would run it (command-watch.ts):
// a `bypassPermissions` thread. Told it everywhere, a worker in `auto` tried it first, was refused, and
// only then started the background shell the refusal named.
test("loadWorkerPrompt(claude) in bypassPermissions is BYTE-IDENTICAL to its own golden", () => {
  assert.equal(loadWorkerPrompt("claude", claudeContractOptions("bypassPermissions", { childThreads: false })), CLAUDE_BYPASS_GOLDEN)
})

test("a Claude worker's contract offers monitors only in bypassPermissions", () => {
  const prompt = (mode: "auto" | "bypassPermissions") => loadWorkerPrompt("claude", claudeContractOptions(mode, { childThreads: false }))
  assert.equal(prompt("auto"), CLAUDE_GOLDEN)
  for (const offer of ["frizzctl monitor add", "--persistent", "cmw_"]) {
    assert.ok(prompt("bypassPermissions").includes(offer), `bypass offers ${offer}`)
    assert.ok(!prompt("auto").includes(offer), `auto does not offer ${offer}`)
  }
  assert.doesNotMatch(prompt("auto"), /\{\{FRIZZ_/, "every token is filled in the auto contract")
  assert.doesNotMatch(prompt("bypassPermissions"), /\{\{FRIZZ_/, "every token is filled in the bypass contract")
})

// The codex contract prints the ABSOLUTE path of the bundled CI/review monitors, which differs per
// checkout — so the golden keeps the unfilled token and the comparison substitutes it back. The fill
// itself is pinned separately below.
test("loadWorkerPrompt(codex) is BYTE-IDENTICAL to its golden (regenerate on deliberate codex edits)", () => {
  const monitors = monitorScriptsDir()
  const normalized = monitors ? loadWorkerPrompt("codex").replaceAll(monitors, "{{FRIZZ_MONITORS_DIR}}") : loadWorkerPrompt("codex")
  assert.equal(normalized, CODEX_GOLDEN)
})

// Codex has no skills and no plugin, so "use the bundled monitors" is only actionable as a path it can
// actually open — an unresolvable one used to be the reason the model wrote its own short-poll loop.
test("the codex contract names the bundled monitors by a path that exists", () => {
  const dir = monitorScriptsDir()
  assert.ok(dir, "the worker plugin ships the portable monitors; resolving it must not fail in the repo")
  assert.ok(existsSync(join(dir!, "ci-watch.mjs")))
  assert.ok(existsSync(join(dir!, "review-watch.mjs")))
  const escaped = dir!.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
  assert.match(loadWorkerPrompt("codex"), new RegExp(`node ${escaped}/ci-watch\\.mjs `))
  assert.match(loadWorkerPrompt("codex"), new RegExp(`node ${escaped}/review-watch\\.mjs `))
})

// The contract must govern RESTING, not just asking. Before this, `The stop criterion` covered only
// when to ask a human — so a worker that finished part one of a two-part instruction, wrote it up and
// rested was doing something no rule addressed, and the write-up templates made it feel correct.
test("both contracts forbid resting while the instruction still has parts left", () => {
  for (const kind of ["claude", "codex"] as const) {
    const c = loadWorkerPrompt(kind).replace(/\s+/g, " ")
    assert.match(c, /COMING TO REST IS A STOP/, `${kind}: resting must be governed like a question`)
    assert.match(c, /do not write up — do the next part in this same turn/, `${kind}: must name the remedy`)
    assert.match(c, /Recording work is not doing work/, `${kind}: must close the scratchpad loophole`)
    assert.match(c, /IT IS OPTIONAL, IT IS NOT A DELIVERABLE/, `${kind}: the pad must read as optional`)
  }
})

test("loadWorkerPrompt: no unresolved {{FRIZZ_*}} markers survive in either backend's contract", () => {
  assert.doesNotMatch(loadWorkerPrompt("claude"), /\{\{FRIZZ_/)
  assert.doesNotMatch(loadWorkerPrompt("codex"), /\{\{FRIZZ_/)
})

test("loadWorkerPrompt(claude) carries the Claude-Code-only guidance", () => {
  const raw = loadWorkerPrompt("claude")
  const c = raw.replace(/\s+/g, " ") // pin content, not line-wrap
  assert.match(c, /a top-level `claude` session/)
  assert.match(c, /`claude -r`/)
  assert.match(c, /## Sub-agents/)
  assert.match(c, /plain Agent tool \+ `run_in_background: true`/)
  // Effort-only profiles since 2026-08-26: the model rides the Agent tool's own parameter, so the 16
  // model×effort cells (and the tiering doctrine their descriptions carried) are gone.
  assert.match(c, /namespaced string `frizz:<effort>`/)
  assert.doesNotMatch(c, /frizz:<model>-<effort>|frizz:opus-high|Bias toward Opus/)
  assert.match(c, /name your scratch directory and the OWN FILE it should write there/)
  // Claude frizz workers have NO fork option (`subagent_type: "fork"` does not resolve); say so
  // explicitly so a worker never blocks hunting for one — the codex fork_context failure mode.
  assert.match(c, /There is NO fork\/inherit option here/)
  assert.match(c, /absence of a fork switch is NOT a blocker to report/)
  assert.match(c, /## Automated waits in Claude Code/)
  assert.match(c, /`Monitor`/)
  assert.match(c, /`persistent: true`/)
  assert.match(c, /TaskOutput[\s\S]{0,80}deprecated/)
  assert.match(c, /`Read` on that output path/)
})

test("loadWorkerPrompt(codex) OMITS every Claude-Code-only construct a codex worker can't use", () => {
  const c = loadWorkerPrompt("codex")
  // No Claude session/wake, no Agent tool, no frizz profiles, no sub-agent blackboard framing.
  assert.doesNotMatch(c, /claude session/)
  assert.doesNotMatch(c, /claude -r/)
  assert.doesNotMatch(c, /## Sub-agents/)
  assert.doesNotMatch(c, /Agent tool/)
  assert.doesNotMatch(c, /run_in_background/)
  assert.doesNotMatch(c, /frizz:<model>-<effort>/)
  assert.doesNotMatch(c, /frizz:opus/)
  assert.doesNotMatch(c, /blackboard/)
})

test("loadWorkerPrompt(codex) carries codex's OWN session/wake + model/effort/sandbox framing", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /a top-level `codex` session/)
  assert.match(c, /`codex resume`/)
  assert.match(c, /## Own one task/)
  assert.match(c, /not the dashboard's portfolio orchestrator/)
  assert.match(c, /Work solo unless the TASK or a later human follow-up explicitly asks/)
  assert.match(c, /## Bounded native delegation/)
  // A PR or issue wait is the server's `watch-pr` / `watch-issue` first (2026-11-04): it runs on Frizz's
  // own credential, so it works where `gh` is signed in only through Keyward, which no monitor can use.
  assert.match(c, /### Waiting on CI and reviews\n\n\*\*For a pull request or an issue, register `frizzctl watch-pr add`/)
  assert.match(c, /`keyward --reason "<what it is for>" -- gh …`/)
  assert.match(c, /`keyward: not released:` stop and report it — never retry/)
  assert.match(c, /project-local `AGENTS\.md`/)
  assert.match(c, /terminal event\/exit semantics/)
  assert.match(c, /never silently shadow it with Frizz/)
  assert.match(c, /persistent `exec_command` \/ `write_stdin` session/)
  assert.match(c, /Luna child is optional\nonly/)
  assert.match(c, /active native spawn tool/)
  // Frizz mounts an MCP server and pre-approves its tools; it sends NO override for the native spawn
  // surface. The prompt said the opposite until 2026-08-26 — it told every codex worker that frizz
  // "requests the V2 surface with process-scoped, version-gated CLI overrides", and no commit ever
  // added such an override (codexAppServerArgv is the single argv builder for all four spawn sites and
  // pushes only the two `-c` values named here). Pin the disclaimer so the false premise cannot return.
  assert.match(c, /Frizz sends NO config override for the native spawn surface/)
  assert.match(c, /trust the callable schema/)
  assert.match(c, /context-fork control/)
  // Both directions must be teachable: fresh for clean-room/adversarial, fork when the child
  // genuinely continues the parent's reasoning. An unset control silently forks EVERYTHING.
  assert.match(c, /Pass NO parent history \(`fork_turns: "none"`\) for an INDEPENDENT/)
  assert.match(c, /FORK instead \(`fork_turns: "all"`/)
  assert.match(c, /schema default is a FULL fork/)
  assert.match(c, /`gpt-5\.6-luna` \+ `medium`/)
  assert.match(c, /`gpt-5\.6-terra` \+ `medium`/)
  // The top rung names the whole ladder, newest first: a catalogue that has dropped Astra still leaves
  // the worker a GPT-6 option before it falls back a generation to 5.6 Sol.
  assert.match(c, /`gpt-6-astra` \+ `high` or `xhigh` \(or `gpt-6-sol`, then `gpt-5\.6-sol`, when the one above it/)
  assert.match(c, /Before any Astra, Sol or xhigh spawn/)
  assert.match(c, /why Terra \+ medium is inadequate/)
  assert.doesNotMatch(c, /do that work INLINE yourself/)
  // The effort enum must match what frizz actually sends codex: codexEffort (backend/codex.ts) passes
  // the complete outer universe through; the selected model gates which levels it accepts.
  assert.match(c, /reasoning effort \(low \/ medium \/ high \/ xhigh \/ max \/ ultra\)/)
  assert.match(c, /read-only/)
  assert.match(c, /workspace-write/)
  assert.match(c, /danger-full-access/)
  assert.match(c, /## Automated waits in Codex/)
  assert.match(c, /persistent `exec_command` \/\n`write_stdin` monitor session/)
  assert.match(c, /`write_stdin`/)
  assert.match(c, /partial\n?`gh pr checks` rollup is not a CI-green verdict/)
  assert.match(c, /`ACTION_REQUIRED` fork gates as pending/)
})

test("loadWorkerPrompt(codex) requests exactly one first-output invisible title comment", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /## Thread title signal/)
  assert.match(c, /<!-- frizz title="Fix queue focus" -->/)
  assert.match(c, /very FIRST assistant message/)
  assert.match(c, /before any[\s\S]*commentary[\s\S]*tool call/)
  assert.match(c, /3-8 word title/)
  assert.match(c, /strips this comment from visible chat/)
  assert.match(c, /human rename always wins/)
  assert.match(c, /Never use an H1\nfor the title signal/)
  assert.doesNotMatch(loadWorkerPrompt("claude"), /<!-- frizz-title:/)
})

test("loadWorkerPrompt(codex) never turns an ordinary thread label into unconditional fan-out", () => {
  const c = loadWorkerPrompt("codex")
  assert.doesNotMatch(c, /Fan out one sub-agent per independent prong/)
  assert.doesNotMatch(c, /re-verified; fan out and loop/)
  assert.doesNotMatch(c, /Draft the plan → dispatch a critic sub-agent/)
  assert.doesNotMatch(c, /dispatch fresh-context reviewer\(s\) on the diff/)
  assert.match(c, /the audit label alone does not authorize fan-out/)
  assert.match(c, /Add fresh-context reviewer agents only under the explicit delegation policy/)
})

test("loadWorkerPrompt: the backend-AGNOSTIC core is present in BOTH contracts", () => {
  for (const kind of ["claude", "codex"] as const) {
    const raw = loadWorkerPrompt(kind)
    // Whitespace-normalized: these pin CONTENT, not line-wrap. Reflowing a paragraph must not fail the
    // suite (the 2026-07-25 restructure broke ~15 assertions purely on rewrapped lines).
    const c = raw.replace(/\s+/g, " ")
    for (const fence of [/```done/, /```awaiting/]) assert.match(raw, fence) // fence grammar
    // A question is a structured ```question fence (2026-10-13); workerPrompt.test.ts pins that every
    // question fence in the contract is one the shared parser registers or references.
    assert.match(raw, /```question\nid: settings-store\nkind: choice\n/)
    if (kind === "codex") assert.match(raw, /## Thread types/) // claude's lean contract drops it
    assert.match(raw, /## Quality bar/)
    assert.match(raw, /## The stop criterion/)
    // THE CURRENT AWAITING GRAMMAR (2026-08-24): YAML frontmatter, PLURAL keys taking LISTS. `human:` used
    // to be pinned here; it is deleted, because it parked a thread in Snoozed and nothing ever fired it.
    // Waiting on a person is a question now (a ```question fence), and this asserts the contract
    // says so rather than merely omitting the old kind.
    assert.match(c, /shells: \[bzvtnt3ig\]/)
    assert.match(c, /for: 2h/)
    // `reason:` IS GONE, and its absence is the whole reason the frontmatter can be YAML: a handoff
    // sentence carries colons and ` #`-refs, which break the parse or silently eat half the line. Pin the
    // RETIREMENT rather than the absence of the string — the contract has to name the key to bury it.
    assert.match(c, /There is no `reason:` key any more/)
    assert.doesNotMatch(c, /- `reason:` —/, "it must never be listed as a usable key again")
    assert.match(c, /NO PROSE ABOVE THE `---`, EVER/)
    assert.doesNotMatch(c, /human:/, "the human gate must not come back")
    // `timer:` NAMES A ROW NOW, never an instant. The instant grammar is deleted: one was written 5h55m
    // in the past, parsed, armed nothing, and stalled its thread for 5.5 hours (2026-08-15).
    assert.match(c, /timers: \[tmr_/)
    assert.doesNotMatch(c, /timer: <ISO-8601 instant>/, "the instant grammar must not come back")
    // The legacy compatibility note is gone with the kinds it described; the contract states the six
    // structural lines and nothing else, so there is no "never emit these" footnote left to carry.
    assert.doesNotMatch(c, /remain parser compatibility/)
    assert.match(raw, /## Agent completion invariant/)
    assert.match(c, /let it run to its terminal return/)
    assert.match(c, /partially applied edits, tests, and owned processes/)
    assert.match(c, /only the affected service, never by stopping a writer/)
    assert.match(raw, /## Showing the human pictures and video/)
    assert.match(c, /reaches them only when you put it there, in a `lightbox` fence/)
  }
})

test("awaiting re-entry: every worker-contract surface requires a fresh fence after a follow-up", () => {
  // This is deliberately pinned across the shipped backend contracts (the single source — the former
  // frizz:worker skill copy was deleted; session-seed is a slim pointer, see its own test). A
  // human turn clears lastFence in the tailer, so merely saying "already parked" cannot restore the
  // state: the worker must make a fresh decision, then repeat a current human/timer fence or re-arm
  // the active backend wait for an automatable condition.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ") // pin content, not line-wrap
    // NAME THE PR ON EVERY REST. The human reads these as a queue of cards from a dozen threads, and one
    // that says "pushed the fix, CI is green" without a number cannot be placed without opening it
    // (maintainer 2026-08-16: "I keep being unclear what PR is being implemented in a given chat").
    assert.match(c, /NAME THE PULL REQUEST, EVERY TIME YOU REST/)
    assert.match(c, /EVERY resting message, not just the one where it first appeared/)
    assert.match(c, /No PR yet.{0,40}say what the work is against instead/)
    assert.match(c, /back to awaiting/)
    assert.match(c, /already parked/)
    assert.match(c, /emit a FRESH fence/)
    // The five YAML keys, in order, and nothing between them a worker could mistake for prose.
    assert.match(c, /shells:[^\n]*agents:[^\n]*timers:[^\n]*prs:[^\n]*for:/)
    // The cutover has to be STATED, not merely applied: every worker dispatched before it has the old
    // grammar frozen in its system prompt, so the contract names the retired keys and what replaced them.
    assert.match(c, /THE SINGULAR KEYS ARE GONE/)
    assert.match(c, /automatable[\s\S]{0,100}(?:arm|re-arm)/i)
  }
})

test("end-state contract: a fenceless rest is a DEFECT, done checks, awaiting parks on checked items", () => {
  // Whitespace-normalized throughout: these pin the RULES, not the line-wrap.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ")
    // REVERSED 2026-08-12. A bare rest used to be "the ordinary handoff"; it is now the one outcome
    // frizz actively corrects (scheduler SOURCE 9), so the contract must not still bless it — a
    // reminder that contradicts the system prompt teaches nothing.
    //
    // The RULE is pinned, not the sentence it was written in. It read "ALWAYS SIGN OFF WITH A FENCE"
    // until 2026-08-27, when a fence stopped being the only way to say it: `done`, `ask` and `watch`
    // each recorded a row frizz read as a sign-off and would not bump for (scheduler SOURCE 9 again). The
    // instruction that must survive is "always sign off", plus the fact that a registration is one.
    //
    // `ask` left it on 2026-10-13 for the fence that registers a question as its message lands — which
    // is still a row, so the rule reads "`frizzctl done` records a ROW, and so does a question".
    //
    // `watch` LEFT THAT LIST ON 2026-10-01. A registration says when the worker wakes; where the thread
    // sits meanwhile is the fence's `status:` answer (`needs_input:` until 2026-10-05), so a rest on
    // running work always takes the fence (board.needsInputQueues, scheduler evalSignoffNudges).
    assert.match(c, /ALWAYS SIGN OFF/)
    assert.doesNotMatch(c, /ALWAYS SIGN OFF WITH A FENCE/, "a fence is no longer the only way to sign off")
    assert.match(c, /`frizzctl done` records a ROW, and so does a question: Frizz registers a ` ```question ` fence the moment the message carrying it lands\. Frizz reads both as a sign-off/)
    assert.doesNotMatch(c, /frizz reads all three as a sign-off/, "a watch alone is no longer a sign-off")
    assert.match(c, /A WAIT IS THE ONE EXCEPTION, and it always takes the fence/)
    // THE ANSWER IS A PLACE (2026-10-05): one required line, three words, one per band — never a second
    // boolean beside the first.
    assert.match(c, /`status:` — REQUIRED: where does the thread sit while the work runs\?/)
    assert.match(c, /`working` — the work finishes BY ITSELF/)
    assert.match(c, /`watching` — the wait is on something OUTSIDE the thread/)
    assert.match(c, /`needs_input` — the human can read, try or act on something NOW/)
    assert.match(c, /`needs_input: true` and `needs_input: false`, the answer before 2026-10-05, are still read/)
    // A rest the human is not queued to read owes them nothing to read (maintainer 2026-10-01).
    assert.match(c, /A QUIET PARK NEEDS NO WRITE-UP/)
    assert.doesNotMatch(c, /parks you on its own/, "a live sub-agent no longer parks the thread by itself")
    assert.match(c, /bare rest[\s\S]{0,90}item nobody can triage/i) // the window widened when "no fence" became "nothing said about where you stand"
    assert.doesNotMatch(c, /bare rest[^.]*ordinary handoff/i)
    // Still says WHERE a fenceless rest lands — the worker has to know the cost of not signing off.
    assert.match(c, /sits in the queue meaning nothing/i)
    assert.match(c, /(?:question|permission)[\s\S]{0,100}higher.priority/i)
    assert.match(c, /checked success card[^.]*queue/)
    assert.match(c, /until the human (?:explicitly )?(?:A|a)rchives? it/)
    // done is gated on LANDED work — merged, not merely committed/pushed/PR-opened (an open PR parks
    // on awaiting until it merges); a pre-fix bug/issue investigation never earns it, while a
    // commissioned research/audit effort's finished report does (done-requires-landed-work)
    assert.match(c, /COMPLETED\s+the effort's real work/)
    assert.match(c, /code LANDED on the project's mainline/)
    assert.match(c, /Code written but not LANDED is not done/)
    assert.match(c, /open PR is work still ahead of the merge/)
    assert.match(c, /`done` waits for the MERGE/)
    // `prs:`, NOT the retired `pr:` or the older `pr-watch:` — a fence written either old way parses as
    // prose and the park names nothing (AWAITING_HINT_RE + RETIRED_AWAITING_KINDS).
    assert.match(c, /park the PR on[\s\S]{0,40}`prs:`/)
    // The git-discipline + implementation-thread surfaces must not contradict it by fencing on a PR.
    assert.match(c, /Opening the PR does NOT finish the thread — the MERGE does/)
    assert.doesNotMatch(c, /done ` fence naming the PR\/paths/)
    assert.doesNotMatch(c, /changes sitting uncommitted/)
    assert.match(c, /investigat(?:ed|ing|ion)[\s\S]{0,300}NOT `?done`?/i)
    assert.match(c, /research or audit EFFORT[\s\S]{0,200}earns `done`/)
    assert.match(c, /awaiting[\s\S]{0,140}(?:human|timestamp)/i)
    assert.match(c, /(?:CI|automatable)[\s\S]{0,180}(?:stay ACTIVE|stay active|active wait|live operation)/i)
    // `done` is taught as a DISMISSAL, not a summary: its card is the one-click path into Inactive
    // (groups.ts), so anything living only in the conversation dies with the thread. The rule is the
    // intent-level heuristic — "points at future work AT ALL" → not done — not a scenario list, and
    // the planning carve-out is DERIVED from it (the artifact outlives the thread), never asserted
    // as an arbitrary exception (done-is-a-dismissal).
    //
    // The 2026-07-25 restructure CUT the rhetorical scaffolding that used to carry this ("ask one
    // question before you fence: if this thread is never opened again…", "Two instances worth
    // naming", "the clearest case of all"). Those were rationale, not rules. The operative rules
    // below are what must survive; do not re-add the essay to satisfy a test.
    assert.match(c, /`done` is a DISMISSAL, not a summary/)
    assert.match(c, /files the thread away where nobody looks again/)
    assert.match(c, /points at future work AT ALL/)
    assert.match(c, /[Uu]ncertain is not done/)
    // Unlanded code and the live code-change discussion remain INSTANCES of the heuristic.
    assert.match(c, /live code-change discussion/)
    assert.match(c, /PLANNING session whose plan file is FULLY written and PERSISTED/)
    // Frizz prescribes NO plan location (the plans feature was dropped 2026-08-24) — the contract must
    // not resurrect one.
    assert.doesNotMatch(c, /\.frizz\/plans/)
    assert.match(c, /artifact already lives outside the thread, so dismissing the thread loses nothing/)
    // 2026-08-16, TWO threads in one sitting fenced `done` on work that was still owed, and both read
    // the contract correctly to get there — so these are the wording defects, not model defects:
    //
    //   zod #6022  reached `decline`, DRAFTED the close comment, wrote "not posted", fenced `done`.
    //              The audit carve-out said a finished report earns `done` and gave no exit condition,
    //              so a verdict that ENDS IN AN ACT the human must perform read as a finished report.
    //   zod #6065  finished its mandate, discovered an unlanded fix, reasoned "the fix is not mine, so
    //              I do not OWE it" — widening "not a process that happens to still be RUNNING" from a
    //              background-process carve-out into a general test — and fenced `done`.
    //
    // Its self-diagnosis also named a real deadlock the contract created: `done` barred by future work,
    // `awaiting` barred with nothing running, `question` seemingly barred with nothing pending, and
    // "bare-rest instead" contradicted by ALWAYS SIGN OFF WITH A FENCE. The resolution is a named
    // section with three ordered exits, and it is what connects spawn_thread to the `done` test.
    assert.match(c, /RECOMMENDATION IS NOT A CONCLUSION, AND AN UNSENT DRAFT IS NOT A DELIVERABLE/)
    assert.match(c, /WROTE but did not SEND/)
    assert.match(c, /BACKGROUND PROCESS that happens to still be running/)
    assert.match(c, /Read that carve-out\s+narrowly: its subject is a running process, and nothing else/)
    assert.match(c, /Follow-up work you DISCOVERED blocks[\s\S]{0,120}even when it is someone else's to do/)
    assert.match(c, /"not mine" is not "not owed"/)
    assert.match(c, /Neither\s+exception stretches to a report that ENDS IN A DECISION the human has yet to make/)
    // The deadlock's exit, in order: do it, hand it to its own card, ask. Never stretch `done`.
    assert.match(c, /### When the work is finished but the thread found more/)
    assert.match(c, /HAND IT OFF TO ITS OWN CARD[\s\S]{0,120}`frizzctl spawn-thread`/)
    assert.match(c, /stretching `done` is not how you break it/)
    assert.match(c, /A bare rest is the residual, not a plan/)
    // The fourth exit is DROP, and it is the one the maintainer asked for by name (2026-08-16): a
    // finished handoff that still trails "one thing to carry forward…" is clutter — too weak to act on,
    // too present to ignore, archived unread. What is not worth a card is not worth a sentence.
    assert.match(c, /DELETE EVERY DANGLING "WORTH DOING LATER"/)
    assert.match(c, /one thing to\s+carry forward…/i)
    assert.match(c, /DO it, SPAWN it onto\s+its own card, ASK about it, or DROP it/)
    // The 2026-08-18 DEMOTION. A spawned thread is fire-and-forget, so a chain of them re-derives the
    // same facts in parallel: `read the file, read up…` (nub) spawned four, three of those spawned more,
    // and three separate descendants independently rediscovered commit 4001cec5c5 over twenty hours
    // because none of them could tell the others. The exits now put DOING it — with a SUB-AGENT, whose
    // result comes back — first, ASK second, and a new card LAST. Maintainer: "these should be SUBAGENTS".
    assert.match(c, /DO IT — the default, and it covers far more than "small"/)
    assert.match(c, /dispatch an in-session SUB-AGENT: its result comes BACK to you/)
    assert.match(c, /Size is not what disqualifies it/)
    assert.match(c, /HAND IT OFF TO ITS OWN CARD — the LAST resort, not the tidy one/)
    assert.match(c, /Never spawn merely to clear your own `done`/)
    // ...and the exits are in that ORDER, since a worker takes the first one that fits.
    const exits = c.indexOf("Take the first exit that fits")
    assert.ok(exits > 0)
    const order = ["1. **DO IT", "2. **ASK", "3. **HAND IT OFF TO ITS OWN CARD", "4. **DROP IT"].map((m) => c.indexOf(m, exits))
    assert.ok(order.every((i) => i > 0), "all four exits present")
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "do it → ask → own card → drop")
    // ...and the card must not restate the prose. Same maintainer note; the rule already existed in
    // this repo's FRIZZ.md but never in the contract every worker gets.
    assert.match(c, /TWO SURFACES, NOT ONE MESSAGE WRITTEN TWICE/)
    assert.match(c, /would read the same in either,\s+it belongs in exactly ONE of them/)
    // ...and spawn_thread's own section points BACK, so a worker reading either one finds the link —
    // carrying the same demotion, because a worker that reads only that section must not come away
    // thinking a spawned card is how it tidies up a barred `done`.
    assert.match(c, /It is the LAST resort among the exits, never the tidy one/)
    assert.match(c, /nothing it learns returns to you or to its siblings unless someone steers it across/)
    assert.match(c, /When the work is\s+finished but the thread found\s+more/)
    assert.doesNotMatch(c, /Its most valuable use is the one that unblocks/)
    // The stop criterion's "you marked it (recommended), so you already knew — implement it instead"
    // is the counter-pull that pushed zod #6022 away from a question. It only holds where the worker
    // CAN act; under a read-only boundary the recommendation IS the question, never a silent `done`.
    assert.match(c, /knowing the answer and being ABLE TO ACT ON IT come apart/)
    assert.match(c, /It becomes the QUESTION, with the recommendation as option A/)
    // The planning thread type derives the same carve-out where a worker reads its deliverable —
    // codex-only now, since claude's lean contract drops ## Thread types. Claude still carries the
    // rule itself in End-of-turn signals (FULLY written and PERSISTED, asserted above).
    if (/## Thread types/.test(raw)) {
      assert.match(c, /WRITTEN, PERSISTED file is the whole reason a planning thread may/)
      assert.match(c, /design outlives the thread's dismissal/)
    }
    // The tail recap repeats the heuristic (not the scenario) for a worker skimming the end.
    assert.match(c, /Nor is a turn on a thread that still points at future work/)
  }
  // The SessionStart seed no longer restates any of this. It carried the fence protocol, the stop
  // criterion and the autonomy rule in full (~1,100 tokens on every startup, resume, clear and compact)
  // until 2026-08-26, when the maintainer had it trimmed: every line of it was already in the system
  // prompt, which is re-applied on every resume and survives compaction. The seed is a pointer now —
  // see "session-seed is a SLIM runtime pointer" below — so these rules are pinned on the contract alone.
  assert.doesNotMatch(SESSION_SEED, /ALWAYS SIGN OFF WITH A FENCE/)
  assert.doesNotMatch(SESSION_SEED, /DECIDE rather than ask/)
})

test("session-seed is a SLIM runtime pointer, not a fourth full contract copy", () => {
  // The full contract lives ONCE in the system prompt (loadWorkerPrompt) — the on-demand frizz:worker
  // skill copy was deleted. The SessionStart hook only re-grounds: it points at the system prompt, carries the runtime
  // scratchpad path + a signal-at-rest anchor, and must NOT re-duplicate the re-entry drill or any
  // browser-QA checklist (that duplication is exactly what drifted and what this slim removes).
  assert.match(SESSION_SEED, /lives in your SYSTEM PROMPT/i)
  // The worker-skill copy is GONE — the seed must not tell workers to load a skill that no longer exists.
  assert.doesNotMatch(SESSION_SEED, /frizz:worker/)
  assert.match(SESSION_SEED, /\.frizz\/threads\//)
  assert.doesNotMatch(SESSION_SEED, /scratch\.md/, "no filename is reserved in the scratch directory")
  for (const fence of [/```done/, /```awaiting/]) assert.match(SESSION_SEED, fence)
  // A question is a ```question fence (2026-10-13): the seed names it, and never the retired command.
  assert.match(SESSION_SEED, /the ```question fence that asks the human/)
  assert.doesNotMatch(SESSION_SEED, /frizzctl (ask|secret)|placement marker/)
  assert.doesNotMatch(SESSION_SEED, /mcp__frizz__/)
  assert.doesNotMatch(SESSION_SEED, /```done \/ ```awaiting \/ ```question/)
  assert.doesNotMatch(SESSION_SEED, /RUNTIME RELEASE GATE:/)
  assert.doesNotMatch(SESSION_SEED, /never build a bespoke screenshot tool/)
  assert.doesNotMatch(SESSION_SEED, /back to awaiting/)
})

test("runtime release gate: WIPED — no worker surface carries browser-QA opinionation", () => {
  // The settings-toggled Runtime-release-gate module was deleted (maintainer 2026-08-03: "extremely
  // overfit to our specific requirements inside of this repo. Wipe it entirely."). Browser-QA policy
  // now belongs to a project's own FRIZZ.md/CLAUDE.md, which frizzConfigBlock injects per repo — never to
  // every worker Frizz dispatches anywhere.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ")
    assert.doesNotMatch(c, /Runtime release gate/i)
    assert.doesNotMatch(c, /SKIP IT for the small and the certain/i)
    assert.doesNotMatch(c, /never build a bespoke screenshot tool/i)
    assert.doesNotMatch(c, /Chrome DevTools MCP/i)
    assert.doesNotMatch(c, /agent-browser/i)
    // The generic, repo-agnostic verification rule stays — it names no browser.
    assert.match(c, /Verify behavior end-to-end before calling anything done/i)
    // …as does the guidance for SHOWING the human the screenshots a worker does produce.
    assert.match(c, /Showing the human pictures and video/)
    assert.match(c, /End-of-turn signals/)
  }
})

// Maintainer 2026-10-03: the lightbox "should be the dominant way for agents to be servicing images to
// the user, and other forms of multimedia … like videos … The agent should be told that, by default,
// everything is collapsed. No images or screenshots are visible unless you make them visible to the user
// with the light box."
test("showing pictures: both contracts say tool output is collapsed and the lightbox fence is the one way to show media", () => {
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ") // pin content, not line-wrap
    // The fact a worker cannot see from inside its session: what it looked at is not on screen.
    assert.match(c, /folds every one into a collapsed row/)
    assert.match(c, /a picture a tool returned included/)
    assert.match(c, /nothing you LOOK at is on their screen/)
    // The one way, for pictures AND video.
    assert.match(c, /reaches them only when you put it there, in a `lightbox` fence/)
    assert.match(raw, /```lightbox\n\/abs\/before\.png {2}Before the fix\n/)
    assert.match(c, /videos are `\.mp4`, `\.webm` or `\.mov`/)
    // Useful and durable: a small set, a finding beside it, a path that survives a reboot.
    assert.match(c, /small, decisive set/)
    assert.match(c, /never `\/tmp`/)
    assert.match(c, /one-line finding beside it/)
    // Where it may and may not go: never after or inside a signal fence (the parser is END-anchored).
    assert.match(c, /above any closing signal fence, never inside one/)
    assert.match(c, /gallery in the body of `frizzctl done`/)
    // Maintainer 2026-10-06: a UI concept is a linked HTML page, never screenshots of one — the old
    // text offered "the screens a design would ship" for a question option, and workers took it.
    assert.match(c, /A UI CONCEPT IS NOT A PICTURE — IT IS A PAGE, AND YOU LINK IT/)
    assert.match(c, /`\[name\]\(file:\/\/\/abs\/path\.html\)`/)
    assert.doesNotMatch(c, /the screens a design would ship/)
    // The retired ways are not taught: no second syntax to choose between, no tool a worker lacks.
    assert.doesNotMatch(c, /!\[descriptive alt\]/)
    assert.doesNotMatch(c, /SendUserFile/)
  }
})

// The web autolinker resolves a bare `#123` against the checkout's `origin`, so in a fork (origin is the
// fork, the PRs live upstream) or a private repo with a public mirror, a bare ref links the wrong repo's
// #123. Only the worker knows which repo it meant, so the contract has it write the repo every time.
test("github refs: both contracts require owner/repo#123 and no longer teach the bare form", () => {
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ")
    assert.match(c, /WRITE EVERY ISSUE AND PR AS `owner\/repo#123`, NEVER A BARE `#123`/)
    assert.match(c, /in a fork, a mirror or a sibling repo is a DIFFERENT repo's #123/)
    assert.match(c, /plain prose, not a code span, so it links/)
    assert.match(c, /one `owner\/repo#123` in the first line or two/)
    assert.doesNotMatch(c, /write the bare form/)
    assert.doesNotMatch(c, /issue numbers and commit hashes link themselves/)
  }
})

// ---- composePrompt: the first VISIBLE user message's scratchpad line is backend-aware ----

test("composePrompt gives each backend's sub-agents their OWN file, never a shared document", () => {
  const claude = composePrompt("sid", "do the thing", "claude")
  assert.match(claude, /Name it in a sub-agent's prompt/)
  assert.match(claude, /give each child its OWN file rather than having them all edit one/)
  assert.equal(composePrompt("sid", "do the thing"), claude) // default = claude (unchanged)

  const codex = composePrompt("sid", "do the thing", "codex")
  assert.match(codex, /Native sub-agents share it — have each write its OWN file/)

  for (const [kind, text] of [["claude", claude], ["codex", codex]] as const) {
    // The merge contract is GONE, not reworded: one file per writer is what removed the hazard.
    assert.doesNotMatch(text, /merge/i, `${kind} must not reintroduce a shared-document merge contract`)
    assert.doesNotMatch(text, /blackboard/, `${kind} must not reintroduce the shared blackboard`)
    // The post-compaction goal stays NAMED as a capability — offered, never pushed (2026-08-28).
    assert.match(text, /`frizzctl goal start --post-compaction`/, `${kind} must name the post-compaction capability`)
  }
  assert.ok(codex.endsWith("do the thing")) // the task still rides through, and rides through LAST
})

// The pad is OPTIONAL and is NOT a deliverable — pinned because the opposite framing has a measured
// behavioural cost. Presented as "the CANONICAL record" with a mandatory "next action" field, a worker
// treats WRITING the next step as equivalent to DOING it, writes "next: X" for an X the human already
// asked for, and rests mid-mandate. Both surfaces must keep saying optional, and must keep saying that
// writing in it is not doing the work.
test("every scratch surface presents notes as optional and never a substitute for the work", () => {
  for (const kind of ["claude", "codex"] as const) {
    const prompt = composePrompt("sid", "do the thing", kind)
    assert.match(prompt, /nothing is expected in it/, `${kind} composePrompt must not present notes as mandatory`)
    assert.match(prompt, /never a substitute for doing the work/, `${kind} composePrompt must refuse the substitution`)
    assert.doesNotMatch(prompt, /CANONICAL/, `${kind} composePrompt must not re-promote a canonical doc`)

    const orientation = scratchpadOrientation("sid", kind)
    assert.match(orientation, /nothing is expected in it/, `${kind} orientation must not present notes as mandatory`)
    assert.match(orientation, /never a substitute for doing the work/, `${kind} orientation must refuse the substitution`)
    assert.doesNotMatch(orientation, /CANONICAL/, `${kind} orientation must not re-promote a canonical doc`)
  }
})

// ---- composePrompt: the system→human handoff carries a loud demarcation banner ----

test("composePrompt puts NOTHING of frizz's below the banner — the operator's prompt is the whole tail", () => {
  const task = "Fix the thing.\n\nWith a second paragraph."
  const composed = composePrompt("sid", task, "claude")

  // The banner sits between the orientation/instructions and the task, padded by blank lines.
  const banner = composed.indexOf("YOUR TASK")
  assert.notEqual(banner, -1)
  // Anchor on the scratchpad orientation: the operator preamble moved to the system prompt, and
  // asserting `indexOf(...) < banner` on an ABSENT string passes vacuously (-1 < banner).
  assert.ok(composed.indexOf(".frizz/threads/") < banner)
  assert.doesNotMatch(composed, /PROJECT INSTRUCTIONS/)
  assert.match(composed, /\n\n\n\n=+\n=+ {4}YOUR TASK {4}=+\n=+\n/)
  // THE property the banner exists for: below it is the operator's prompt, byte for byte. The framing
  // note that used to sit underneath now sits above, and the bare `TASK:` marker is gone entirely.
  assert.ok(composed.endsWith(`${DISPATCH_TASK_BANNER_MARKER}${task}`))
  assert.equal(composed.indexOf(DISPATCH_TASK_BANNER_MARKER), composed.lastIndexOf(DISPATCH_TASK_BANNER_MARKER))
  assert.ok(!composed.includes("\nTASK:\n"))
  assert.ok(composed.indexOf("frizz system orientation") < banner)

  // Round-trip through the real parser: the UI's first user message shows exactly the human's words,
  // while the stored text keeps the whole machine-facing prompt the worker actually received.
  const raw = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { content: composed },
  })
  const [message] = parseTranscript(raw)
  assert.equal(message.displayText, task)
  assert.equal(message.text, composed)
})

// The broker runtime delivers the dispatch prompt as a `queue-operation` enqueue record, NOT as a plain
// `user` record — which is how the whole composed prompt (orientation, project instructions, banner and
// all) ended up rendered in the first chat bubble of every broker thread.
test("composePrompt round-trips through the BROKER's enqueue record with the same bubble", () => {
  const task = "run `claude rc` in this repo"
  const composed = composePrompt("sid", task, "claude")
  const raw = [
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:00.000Z", operation: "enqueue", content: composed }),
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:00.100Z", operation: "dequeue", content: composed }),
  ].join("\n")
  const [message] = parseTranscript(raw)
  assert.equal(message.displayText, task)
  assert.equal(message.text, composed) // the raw content stays the queued-bubble map's key
  assert.equal(message.queued, false)
})

// ---- scratchpadOrientation: the SYSTEM-level line is backend-aware ----

test("scratchpadOrientation names the directory, the arming, and one file per sub-agent", () => {
  const claude = scratchpadOrientation("sid", "claude")
  assert.match(claude, /SCRATCH DIRECTORY: \.frizz\/threads\/sid\//)
  assert.match(claude, /name it in a sub-agent's prompt when you want its notes back, and give each child its own file/)
  assert.equal(scratchpadOrientation("sid"), claude)

  const codex = scratchpadOrientation("sid", "codex")
  assert.match(codex, /native sub-agents share it, so give each its own file/)

  for (const [kind, text] of [["claude", claude], ["codex", codex]] as const) {
    // The post-compaction trigger stays named as an available capability, never a prescription.
    assert.match(text, /`frizzctl goal start --post-compaction`/, `${kind} must name the trigger`)
    assert.match(text, /Nothing in this directory is read automatically/, `${kind} must not imply an injection`)
    assert.doesNotMatch(text, /merge/i, `${kind} must not reintroduce the merge contract`)
    assert.doesNotMatch(text, /scratch\.md/, `${kind} must not reserve a filename`)
  }
})

// ---- workerDispatchPermission: the Settings-driven launch mode for a NEW worker ----
// The floor (WORKER_DISPATCH_PERMISSION) keeps an unattended worker out of any mode that could stall it
// on an unanswerable prompt. The ONE deviation Settings can ask for is bypassPermissions on Claude,
// which is strictly more permissive and therefore cannot softlock.

test("workerDispatchPermission: Claude launches at the auto floor unless Settings asks to bypass", () => {
  assert.equal(workerDispatchPermission("claude", { permissionMode: "auto" }), "auto")
  assert.equal(workerDispatchPermission("claude", { permissionMode: "bypassPermissions" }), "bypassPermissions")
  assert.equal(WORKER_DISPATCH_PERMISSION.claude, "auto") // the floor itself is still auto
})

test("workerDispatchPermission: a restrictive stored mode can never reach a Claude spawn", () => {
  // Settings.permissionMode accepts the whole enum (it predates this control), but every mode that
  // would park a headless worker on a modal nobody is watching coerces back to the floor.
  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    assert.equal(workerDispatchPermission("claude", { permissionMode: mode }), "auto")
  }
})

test("workerDispatchPermission: codex ignores the Claude setting and stays at full access", () => {
  // Codex has no permission-mode axis to raise — it already dispatches at danger-full-access, and the
  // Settings control is Claude-only, so neither value may move it.
  assert.equal(workerDispatchPermission("codex", { permissionMode: "auto" }), "bypassPermissions")
  assert.equal(workerDispatchPermission("codex", { permissionMode: "bypassPermissions" }), "bypassPermissions")
})

test("buildClaudeCommand carries bypassPermissions through to --permission-mode", () => {
  // The spawned-CLI fallback transport. (The broker — the default — passes the same mode into the SDK, which
  // additionally sets allowDangerouslySkipPermissions for exactly this value.)
  const argv = buildClaudeCommand({ sessionId: "bypass-dispatch", permissionMode: "bypassPermissions", prompt: "test", workerPrompt: "" })
  assert.deepEqual(
    argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2),
    ["--permission-mode", "bypassPermissions"],
  )
})
