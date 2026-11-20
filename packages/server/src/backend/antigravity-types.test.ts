import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  antigravityCommandLine, antigravityLaunchArgs, antigravityOption, antigravityPermissionParams, antigravityProfileOf, antigravityQuotaFromUsage, antigravitySessionMode,
  antigravityTier, antigravityToolShape, AntigravityUsage, isPlainFrizzctlCommand,
} from "./antigravity-types.ts"

test("antigravity: bypass is the launch flag, and every other mode is a session mode", () => {
  assert.deepEqual(antigravityLaunchArgs("bypassPermissions"), ["acp", "--dangerously-skip-permissions"])
  for (const mode of ["auto", "default", "acceptEdits", "plan", null, undefined] as const) assert.deepEqual(antigravityLaunchArgs(mode), ["acp"], String(mode))
  assert.deepEqual(
    (["default", "acceptEdits", "auto", "plan", "bypassPermissions", null] as const).map((mode) => antigravitySessionMode(mode)),
    ["default", "accept-edits", "auto", "plan", "default", "default"],
  )
})

test("antigravity: a thread row's profile is the model inside its slug, its effort and its mode", () => {
  assert.deepEqual(antigravityProfileOf({ model: "antigravity:gemini-4-neon", effort: "xhigh", permission_mode: "acceptEdits" }), { modelId: "gemini-4-neon", effort: "xhigh", permissionMode: "acceptEdits" })
  // The bare slug is agy's own configured model; an empty effort and an unknown mode ask for nothing.
  assert.deepEqual(antigravityProfileOf({ model: "antigravity:", effort: "", permission_mode: "nonsense" }), { modelId: null, effort: null, permissionMode: null })
  assert.deepEqual(antigravityProfileOf({}), { modelId: null, effort: null, permissionMode: null })
})

test("antigravity: a config option is found by its category, then by its id", () => {
  const options = [
    { id: "m", name: "Model", category: "model", type: "select" as const, currentValue: "a", options: [] },
    { id: "thought_level", name: "Level", type: "select" as const, currentValue: "high", options: [] },
  ]
  assert.equal(antigravityOption(options, "model")?.id, "m")
  assert.equal(antigravityOption(options, "thought_level")?.currentValue, "high")
  assert.equal(antigravityOption(options, "mode"), undefined)
  assert.equal(antigravityOption(null, "model"), undefined)
})

test("antigravity: its tool calls are written in the vocabulary Frizz's cards are built from", () => {
  assert.deepEqual(antigravityToolShape("run_command", { CommandLine: "nub test", WaitMsBeforeAsync: 5000, toolSummary: "Running the tests" }), { name: "Bash", input: { command: "nub test", description: "Running the tests" } })
  assert.deepEqual(antigravityToolShape("run_command", { CommandLine: "nub dev", IsDaemon: true }), { name: "Bash", input: { command: "nub dev", run_in_background: true } })
  assert.deepEqual(antigravityToolShape("read_file", { Path: "/p/a.ts", StartLine: 10, EndLine: 19 }), { name: "Read", input: { file_path: "/p/a.ts", offset: 10, limit: 10 } })
  assert.deepEqual(antigravityToolShape("write_file", { Path: "/p/a.ts", Content: "x" }), { name: "Write", input: { file_path: "/p/a.ts", content: "x" } })
  assert.deepEqual(antigravityToolShape("edit_file", { Path: "/p/a.ts", Target: "old", Replacement: "new" }), { name: "Edit", input: { file_path: "/p/a.ts", old_string: "old", new_string: "new" } })
  assert.deepEqual(antigravityToolShape("search_web", { query: "acp" }), { name: "WebSearch", input: { query: "acp" } })
  assert.deepEqual(antigravityToolShape("invoke_subagent", { Role: "Reviewer", Prompt: "Review it", TypeName: "general", Model: "gemini-4-neon" }), { name: "Agent", input: { description: "Reviewer", prompt: "Review it", subagent_type: "general", model: "gemini-4-neon" } })
  assert.deepEqual(
    antigravityToolShape("ask_question", { questions: [{ question: "Which?", is_multi_select: true, options: ["A", { label: "B" }] }] }),
    { name: "AskUserQuestion", input: { questions: [{ question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] } },
  )
  // A tool with no counterpart keeps its own name and input, and draws as a plain row.
  assert.deepEqual(antigravityToolShape("manage_task", { op: "list" }), { name: "manage_task", input: { op: "list" } })
  assert.deepEqual(antigravityToolShape("run_command", "not an object"), { name: "Bash", input: { command: "" } })
})

test("antigravity: only one plain frizzctl call is approved without asking", () => {
  const plain = [
    "frizzctl done",
    "  frizzctl title 'Fix the lookup'  ",
    "frizzctl watch shell bzvtnt3ig --for 2h",
    'frizzctl link "Dev server" http://127.0.0.1:5173/',
    "frizzctl timer set --in-seconds 600 --description 'Check the build'",
    "frizzctl done --body-file - <<'EOF'\n- **Fixed** `src/a.ts`; $(not run) and `backticks` are literal here.\nEOF",
    "frizzctl done --body-file - <<'EOF'\nbody\nEOF\n\n",
  ]
  for (const command of plain) assert.equal(isPlainFrizzctlCommand(command), true, command)
  const asks = [
    "frizzctl done && rm -rf build",
    "frizzctl done; rm -rf build",
    "frizzctl done | tee out",
    "frizzctl done > out",
    "frizzctl title $(whoami)",
    "frizzctl title `whoami`",
    'frizzctl title "$HOME"',
    'frizzctl title "a `b` c"',
    "frizzctl done\nrm -rf build",
    // An UNQUOTED heredoc delimiter expands its body, and text after the heredoc is a second command.
    "frizzctl done --body-file - <<EOF\n$(rm -rf build)\nEOF",
    "frizzctl done --body-file - <<'EOF'\nbody\nEOF\nrm -rf build",
    "frizzctl done --body-file - <<'EOF'\nnever closed",
    "env X=1 frizzctl done",
    "/tmp/frizzctl done",
    "frizzctlx done",
    "rm -rf build",
    "",
  ]
  for (const command of asks) assert.equal(isPlainFrizzctlCommand(command), false, command)
  // A shell's blanks are the space and the tab. Anything else JavaScript calls whitespace is an ordinary
  // character to a shell, and one beside the delimiter becomes part of it: the heredoc then closes on
  // the line carrying the same character, and `echo BREACH` runs.
  for (const [name, c] of Object.entries({ FF: "\f", VT: "\v", CR: "\r", NBSP: " ", EMSP: " ", LSEP: " ", BOM: "﻿" })) {
    assert.equal(isPlainFrizzctlCommand(`frizzctl done --body-file - <<${c}'EOF'\n${c}EOF\necho BREACH\nEOF`), false, `${name} before the delimiter`)
    assert.equal(isPlainFrizzctlCommand(`frizzctl done --body-file - <<'EOF'${c}\nEOF${c}\necho BREACH\nEOF`), false, `${name} after the delimiter`)
    assert.equal(isPlainFrizzctlCommand(`frizzctl done${c}--body-file - <<'EOF'\nbody\nEOF`), false, `${name} between words`)
    assert.equal(isPlainFrizzctlCommand(`${c}frizzctl done`), false, `${name} before the command`)
    assert.equal(isPlainFrizzctlCommand(`frizzctl done --body-file - <<'EOF'\nbody\nEOF\n${c}`), false, `${name} after the heredoc`)
  }
  assert.equal(isPlainFrizzctlCommand("frizzctl done --body-file - <<'EOF'\r\nbody\r\nEOF\r\n"), false, "CRLF line endings")
  assert.equal(isPlainFrizzctlCommand("frizzctl title 'a\u0000b'"), false, "a NUL cuts the command short")
  assert.equal(isPlainFrizzctlCommand("\n\t frizzctl done --body-file -\t<<\t'EOF' \nbody\nEOF\n \t\n"), true, "spaces, tabs and blank lines are a shell's own blanks")
})

test("antigravity: what the frizzctl check approves, a real shell runs as one frizzctl call and nothing else", () => {
  const shells = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((sh) => existsSync(sh))
  if (!shells.length) return
  // A seeded generator, so a failure names a command that fails again.
  let seed = 0x5eed1e55
  const random = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
  const blanks = [" ", " ", " ", "\t", "  ", "", "\f", "\v", "\r", " ", " "]
  const words = ["done", "title", "--body-file", "-", "a=b", "x/y.z", "--for", "2h", "'two words'", "'a; echo BREACH'", "'$(echo BREACH)'", "'`echo BREACH`'", '"plain words"', '"a; echo BREACH"', '"a | b > c"', '"$(echo BREACH)"', '"`echo BREACH`"', "$(echo BREACH)", "`echo BREACH`", "a;echo", "*", "~", "{a,b}", "'unclosed", '"unclosed', "2"]
  const heredocs = ["<<'EOF'", "<<'EOF'", "<<'EOF'", "<< 'EOF'", "<<\t'EOF'", "<<EOF", '<<"EOF"', "<<-'EOF'", "<<<'EOF'", "<<'E O F'", "<<''"]
  const bodyLines = ["body", "body", "", "EOF", "EOF ", " EOF", "\fEOF", "EOF\f", "\rEOF", "EOF\r", " EOF", "echo BREACH", "$(echo BREACH)", "`echo BREACH`", "E O F"]
  const tails = ["", "", "", "", ";echo BREACH", "\necho BREACH", "|echo BREACH", "&&echo BREACH", "&echo BREACH", ">out", "\n", " \n\t\n", "\n\f", "\n "]
  const build = (): string => {
    let command = `${pick(["", "", "", " ", "\n", "\f", "\t"])}frizzctl`
    for (let i = Math.floor(random() * 4); i > 0; i--) command += pick(blanks) + pick(words)
    if (random() < 0.6) {
      command += pick(blanks) + pick(heredocs) + pick(["", "", " ", "\t", "\f", "\r", " "])
      for (let i = Math.floor(random() * 5); i > 0; i--) command += `\n${pick(bodyLines)}`
      if (random() < 0.85) command += "\nEOF"
    }
    return command + pick(tails)
  }
  const approved = new Set<string>()
  for (let i = 0; i < 20_000 && approved.size < 60; i++) { const command = build(); if (isPlainFrizzctlCommand(command)) approved.add(command) }
  assert.ok(approved.size >= 40, `the generator reaches the approved shapes (${approved.size})`)
  // `frizzctl` is a function made of builtins, and nothing else resolves: a second command either prints
  // (a builtin) or complains that it was not found, and either one fails the comparison.
  const prelude = 'frizzctl() { while IFS= read -r _line; do :; done; echo "CALLED $#"; }\nPATH=/nonexistent\n'
  const cwd = mkdtempSync(join(tmpdir(), "agy-frizzctl-"))
  try {
    for (const command of approved) {
      for (const shell of shells) {
        const ran = spawnSync(shell, ["-c", prelude + command], { cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
        assert.match(ran.stdout, /^CALLED \d+\n$/, `${shell} ran exactly one frizzctl for ${JSON.stringify(command)} (stderr: ${ran.stderr})`)
        assert.equal(ran.stderr, "", `${shell} had nothing to say about ${JSON.stringify(command)}`)
      }
    }
    assert.deepEqual(readdirSync(cwd), [], "nothing was written")
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test("antigravity: a command line is read off run_command alone", () => {
  assert.equal(antigravityCommandLine("run_command", { CommandLine: "frizzctl done" }), "frizzctl done")
  assert.equal(antigravityCommandLine(undefined, { CommandLine: "ls" }), "ls", "a request that names no tool is read by its input")
  assert.equal(antigravityCommandLine("write_file", { CommandLine: "frizzctl done" }), undefined)
  assert.equal(antigravityCommandLine("run_command", {}), undefined)
})

test("antigravity: a permission request's input is renamed to the keys the shared card builder reads", () => {
  const params = { sessionId: "s", toolCall: { toolCallId: "c1", title: "rm", kind: "execute" as const, rawInput: { CommandLine: "rm -rf build", WaitMsBeforeAsync: 5000, toolSummary: "Cleaning", Cwd: "/p" } }, options: [] }
  assert.deepEqual(antigravityPermissionParams(params).toolCall.rawInput, { command: "rm -rf build", Cwd: "/p" })
  const edit = { ...params, toolCall: { ...params.toolCall, rawInput: { Path: "/p/a.ts", Target: "old", Replacement: "" } } }
  assert.deepEqual(antigravityPermissionParams(edit).toolCall.rawInput, { path: "/p/a.ts", replace: "old", with: "" })
  const bare = { ...params, toolCall: { toolCallId: "c2" } }
  assert.equal(antigravityPermissionParams(bare), bare)
})

test("antigravity: the plan and the quota report are read where agy puts them", () => {
  assert.deepEqual(antigravityTier({ sessionId: "x", _meta: { antigravity: { tier: { id: "free-tier", name: "Free" } } } }), { id: "free-tier", name: "Free" })
  assert.equal(antigravityTier({ sessionId: "x" }), undefined)
  const usage = AntigravityUsage.parse({
    command: { name: "usage", data: { groups: [{ name: "Gemini", buckets: [{ id: "g-5h", name: "5 hour", window: "5h", remaining_fraction: 0.42, reset_time: "2026-11-20T15:00:00Z", extra: 1 }] }] } },
  })
  assert.equal(usage.command.data.groups[0]!.buckets[0]!.remaining_fraction, 0.42)
})

test("antigravity: a usage report becomes one quota window per limit, scoped to the models its group names", () => {
  // agy 1.5.13 on the free plan, 2026-11-20.
  const usage = AntigravityUsage.parse({
    command: { name: "usage", data: { groups: [
      { name: "Gemini Models", description: "Models within this group: Gemini 3.8 Flash", buckets: [{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.75, reset_time: "2026-11-27T18:21:42Z" }] },
      { name: "Claude and GPT models", description: "Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B", buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-27T19:44:49Z" }] },
    ] } },
  })
  const account = {
    defaultModel: "gemini-3.8-flash",
    tier: "Antigravity Starter Quota",
    models: [
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      // The menu's names carry a suffix the report's do not.
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
      { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  }
  assert.deepEqual(antigravityQuotaFromUsage(usage, account), {
    status: "ok",
    // Printed as "Antigravity · Starter plan".
    planType: "Starter",
    windows: [
      { key: "gemini-weekly", label: "Gemini", usedPercent: 25, resetsAt: 1795803702, models: ["gemini-3.8-flash", ""] },
      { key: "3p-weekly", label: "Claude and GPT", usedPercent: 0, resetsAt: 1795808689, models: ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"] },
    ],
  })
  // A group that does not say which models it holds meters all of them; several limits in one group
  // are told apart by their window; a fraction outside 0..1 and an unreadable date are not passed on.
  const loose = AntigravityUsage.parse({
    command: { data: { groups: [{ name: "All models", buckets: [
      { window: "5h", remaining_fraction: 1.4, reset_time: "soon" },
      { window: "weekly", remaining_fraction: -0.2 },
    ] }] } },
  })
  assert.deepEqual(antigravityQuotaFromUsage(loose, { models: [] }).windows, [
    { key: "all-models-5h", label: "All, 5h", usedPercent: 0 },
    { key: "all-models-weekly", label: "All, weekly", usedPercent: 100 },
  ])
  assert.equal(antigravityQuotaFromUsage(usage, { ...account, tier: "Google AI Pro" }).planType, "Google AI Pro")
  assert.deepEqual(antigravityQuotaFromUsage(AntigravityUsage.parse({ command: { data: { groups: [] } } }), { models: [] }), { status: "unavailable", windows: [], detail: "Antigravity reported no limits" })
})
