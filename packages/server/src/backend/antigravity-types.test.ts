import { test } from "node:test"
import assert from "node:assert/strict"
import {
  antigravityCommandLine, antigravityLaunchArgs, antigravityOption, antigravityPermissionParams, antigravityProfileOf, antigravitySessionMode,
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
