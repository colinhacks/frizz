import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GITHUB_DISPATCH_UI_BOUNDARY, wakeDeliveryToken } from "@frizz/shared"
import { pageProjectedTranscript, parseCodexTranscript, projectCodexTranscript } from "./transcript.ts"
import { projectStateDir, resetFrizzRoots } from "./frizz-paths.ts"
import { CODEX_FIRST_FINAL_TITLE_TRANSPORT, CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT } from "./backend/codex.ts"

// ---- codex rollout → TranscriptMessage[] (the chat-drawer render path) ----
// Grounded in REAL captured rollouts (codex-cli 0.144.1) — the SAME fixtures backend/codex.test.ts folds
// for board telemetry, so the drawer render and the board can never disagree about a record's meaning.
// Every record shape codex emits must map onto a renderable card or degrade cleanly (never throw, never
// a blank pane). Synthetic cases below cover shapes the two fixtures don't exercise (apply_patch, the
// argv `shell` tool, the dispatch-scaffolding strip, malformed lines).

const FIX = join(import.meta.dirname, "backend", "codex.fixtures")
const tuiSingleTurn = readFileSync(join(FIX, "tui-single-turn.jsonl"), "utf8")
const execTwoTurn = readFileSync(join(FIX, "exec-two-turn.jsonl"), "utf8")
const execWrapperCommonTools = readFileSync(join(FIX, "exec-wrapper-common-tools.jsonl"), "utf8")
// A REAL captured rollout (codex-cli 0.144.1) of a worker that read/wrote/edited files, listed the dir,
// and ran git status — the diverse tool surface, INCLUDING two apply_patch edits delivered as codex
// `custom_tool_call` records (which parseCodexLine had to be extended to map, else every edit vanished).
const tuiApplyPatch = readFileSync(join(FIX, "tui-apply-patch.jsonl"), "utf8")

test("codex fixture (tui-single-turn): user prompt + assistant turn with an exec Bash card carrying its output", () => {
  const msgs = parseCodexTranscript(tuiSingleTurn)
  // The turn's task_complete bracket closes it with the rest divider — see the dedicated test below.
  assert.equal(msgs.length, 3)
  assert.equal(msgs[2].boundary, "rest")

  assert.equal(msgs[0].role, "user")
  assert.match(msgs[0].text, /Read hello\.txt with cat/)

  const a = msgs[1]
  assert.equal(a.role, "assistant")
  // The final answer (with its ```done fence) renders as the assistant prose.
  assert.match(a.text, /```done\ntui-ok\n```/)
  // The exec_command call renders as a Bash card carrying the command AND its (envelope-stripped) output.
  assert.equal(a.tools.length, 1)
  assert.equal(a.tools[0].name, "Bash")
  assert.equal(a.tools[0].command, "cat hello.txt")
  assert.equal(a.tools[0].output, "tui file")
  assert.equal(a.tools[0].edit, undefined)
  // parts preserve tool-then-text order (the card sits above the answer it introduced).
  assert.deepEqual(
    a.parts.map((p) => p.kind),
    ["tools", "text"],
  )
})

test("Codex title transport is hidden from first commentary and every finalized response while legacy H1 remains compatible", () => {
  const opening = '<!-- frizz title="Fix queue focus" -->\nI’m checking the queue.'
  const first = '<!-- frizz title="Fix queue focus" -->\nFirst visible answer'
  const later = "# Quoted later marker\nSecond visible answer"
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "first task" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: opening } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: first } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: first } },
    { type: "event_msg", payload: { type: "user_message", message: "follow-up" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: later } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: later } },
  ])
  const msgs = parseCodexTranscript(raw)
  // Each turn's task_complete closes it with the rest divider (an `event`, not a bubble).
  assert.deepEqual(msgs.map((m) => m.boundary ?? m.role), ["user", "assistant", "assistant", "rest", "user", "assistant", "rest"])
  assert.equal(msgs[1].text, "I’m checking the queue.")
  assert.equal(msgs[2].text, "First visible answer")
  assert.doesNotMatch(JSON.stringify(msgs), /Fix queue focus/)
  assert.equal(msgs[5].text, "Second visible answer")
  assert.doesNotMatch(JSON.stringify(msgs[5]), /Quoted later marker/)
})

test("Codex commentary keeps an ordinary leading H1 while hiding only the new attribute transport", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "task" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "# Progress\nStill working." } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Done." } },
  ])
  const msgs = parseCodexTranscript(raw)
  assert.match(msgs[1].text, /^# Progress/)
})

test("Codex task_complete-only fallback strips the first title marker from visible prose", () => {
  const answer = "<!-- frizz-title: Completion fallback -->\nVisible fallback"
  const msgs = parseCodexTranscript(rollout([
    { type: "event_msg", payload: { type: "user_message", message: "task" } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: answer } },
  ]))
  assert.equal(msgs[1].text, "Visible fallback")
  assert.doesNotMatch(JSON.stringify(msgs), /frizz-title/)
})

test("a codex turn bracket closes the turn with a rest divider, and separates back-to-back turns", () => {
  // task_complete/turn_aborted is codex's turn bracket — the same signal backend/codex.ts folds into
  // `turn-end` for the board's idle state. Two consecutive turns with no human message between them
  // used to paint as ONE bubble (only a user message closed `cur`); the divider closes it as well.
  const msgs = parseCodexTranscript(rollout([
    { type: "event_msg", payload: { type: "user_message", message: "go" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "First turn." } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "First turn." } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Second turn." } },
    { type: "event_msg", payload: { type: "turn_aborted" } },
  ]))
  assert.deepEqual(msgs.map((m) => m.boundary ?? m.role), ["user", "assistant", "rest", "assistant", "rest"])
  assert.equal(msgs[1].text, "First turn.")
  assert.equal(msgs[2].text, "Agent rested")
  assert.equal(msgs[3].text, "Second turn.", "the second turn is its own bubble, below the first turn's rule")
})

test("a second codex bracket for one turn does not stack a second rule", () => {
  // turn_aborted can follow task_complete for the same turn. One rest, one rule.
  const msgs = parseCodexTranscript(rollout([
    { type: "event_msg", payload: { type: "user_message", message: "go" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Done." } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Done." } },
    { type: "event_msg", payload: { type: "turn_aborted" } },
  ]))
  assert.equal(msgs.filter((m) => m.boundary === "rest").length, 1)
})

test("codex fixture (exec-two-turn): two turns; multi-tool run; empty output dropped; commentary interleaves", () => {
  const msgs = parseCodexTranscript(execTwoTurn)
  assert.equal(msgs.length, 9)
  assert.deepEqual(
    msgs.map((m) => m.boundary ?? m.role),
    ["user", "assistant", "rest", "user", "assistant", "assistant", "assistant", "assistant", "rest"],
  )

  // Turn 1: two exec calls in one run → one coalesced tools band, results back-filled by call_id.
  const t1 = msgs[1]
  assert.deepEqual(
    t1.tools.map((t) => t.command),
    ["cat hello.txt", "printf 'ok' > note.txt"],
  )
  assert.equal(t1.tools[0].output, "test file")
  // The write produced no stdout → no output pane (an empty result is dropped, not a blank card).
  assert.equal(t1.tools[1].output, undefined)
  assert.match(t1.text, /```done\nall-good\n```/)

  // Turn 2: commentary before each tool → text/tools/text/tools/text/tools/text interleave.
  const t2 = msgs.slice(4, 8)
  assert.deepEqual(
    t2.flatMap((m) => m.tools).map((t) => t.command),
    ["date", "ls", "wc -l hello.txt"],
  )
  assert.match(t2[1].tools[0].output ?? "", /hello\.txt/) // the ls listing
  assert.deepEqual(
    t2.map((m) => m.parts.map((p) => p.kind)),
    [["text", "tools"], ["text", "tools"], ["text", "tools"], ["text"]],
  )
  // The final answer's ```awaiting fence rides the assistant prose.
  assert.match(t2[3].text, /```awaiting/)
})

test("codex fixture (tui-apply-patch): the full tool surface — reads, a write, apply_patch EDITS, ls, git — all render", () => {
  const msgs = parseCodexTranscript(tuiApplyPatch)
  assert.equal(msgs.length, 10)
  assert.equal(msgs.at(-1)?.boundary, "rest")
  const a = msgs[1]
  assert.equal(a.role, "assistant")

  // Shell commands render as Bash cards carrying their output.
  const bash = msgs.flatMap((m) => m.tools).filter((t) => t.command)
  assert.deepEqual(
    bash.map((t) => t.command),
    ["cat hello.txt", "printf 'codex-was-here' > note.txt", "cat greeter.js", "ls -la", "git status"],
  )
  assert.equal(bash[0].output, "test file")
  assert.match(bash[4].output ?? "", /On branch main/)

  // apply_patch edits (codex custom_tool_call) render as Edit diff cards — the whole point of the
  // custom_tool_call extension; without it these two edits would be invisible.
  const edits = msgs.flatMap((m) => m.tools).filter((t) => t.edit)
  assert.equal(edits.length, 2)
  assert.ok(edits.every((t) => t.name === "Edit" && t.edit?.file.endsWith("greeter.js")))
  // The successful patch flips "hi " → "hello " in greet().
  assert.ok(edits.some((t) => /hello " \+ name/.test(t.edit?.new ?? "")))

  // The final answer (the ```done fence) rides the assistant prose.
  assert.match(msgs.at(-2)!.text, /```\ndone\ne2e-tools-ok\n```/)
})

test("codex fixture (exec wrapper): common nested tools expose command, input, result, and failures", () => {
  const msgs = parseCodexTranscript(execWrapperCommonTools)
  assert.deepEqual(msgs.map((m) => m.boundary ?? m.role), ["user", "assistant", "rest"])
  const a = msgs[1]
  assert.equal(a.tools.length, 9)
  assert.deepEqual(a.tools.map((t) => t.name), ["Todos", "Bash", "Bash", "Bash", "Bash", "Bash", "Edit", "Edit", "Todos"])

  // `update_plan` is codex's built-in TO-DO LIST, so it projects the plan itself (see transcript.ts's
  // TO-DO LIST section) rather than a "2 steps · 0/2 complete" summary with the raw args as its body.
  // No server-side `detail`: the card's headline is the step in progress, which the client reads off the
  // list it was given rather than the server pre-rendering a sentence for it.
  const planStart = a.tools[0]
  assert.equal(planStart.detail, undefined)
  assert.deepEqual(planStart.todos, [
    { text: "Inspect the sample", status: "in_progress" },
    { text: "Patch and verify", status: "pending" },
  ])
  assert.equal(planStart.input, undefined, "this call carried no explanation, so there is no note pane")
  assert.equal(planStart.status, "completed")
  assert.equal(planStart.output, undefined)

  const bash = a.tools.filter((t) => t.name === "Bash")
  assert.deepEqual(bash.map((t) => t.command), [
    "pwd",
    "cat README.md",
    "rg -n \"TOOL_RENDER_NEEDLE\" .",
    "printf 'alpha\\nbeta\\n'\nprintf 'alpha\\nbeta\\n' | wc -l",
    "printf 'expected failure\\n' >&2\nexit 7",
  ])
  assert.equal(bash[0].output, "/tmp/frizz-tool-sample")
  assert.equal(bash[2].output, "README.md:1:TOOL_RENDER_NEEDLE")
  assert.equal(bash[4].status, "failed")
  assert.equal(bash[4].exitCode, 7)
  assert.equal(bash[4].output, "expected failure")

  const [failedPatch, successfulPatch] = a.tools.filter((t) => t.name === "Edit")
  assert.equal(failedPatch.status, "failed")
  assert.match(failedPatch.input ?? "", /Begin Patch/)
  assert.match(failedPatch.output ?? "", /verification failed/)
  assert.equal(successfulPatch.status, "completed")
  assert.equal(successfulPatch.edit?.file, "/tmp/frizz-tool-sample/src/greet.ts")
  assert.match(successfulPatch.edit?.new ?? "", /hello/)

  // The closing plan: everything done, so the card headlines nothing and its counter says 2/2. The
  // `explanation` becomes the note pane the raw args used to occupy.
  assert.equal(a.tools[8].detail, undefined)
  assert.deepEqual(a.tools[8].todos, [
    { text: "Inspect the sample", status: "completed" },
    { text: "Patch and verify", status: "completed" },
  ])
  assert.equal(a.tools[8].input, "Fixture complete.")
  assert.match(a.text, /FRIZZ_TOOL_RENDER_FIXTURE_DONE/)
})

test("Codex narration remains independently collapsible across reasoning, including a bracket-only final answer", () => {
  for (const bracketOnly of [false, true]) {
    const events: Parameters<typeof rollout>[0] = [
      { type: "event_msg", payload: { type: "user_message", message: "Fix the drawer" } },
    ]
    for (const [i, text] of ["Tracing the drawer", "Reading the stack", "Checking the fix"].entries()) {
      events.push(
        { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: text } },
        { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "**Inspecting the handler**" }] } },
        { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `call-${i}`, arguments: JSON.stringify({ cmd: `echo ${i}` }) } },
        { type: "response_item", payload: { type: "function_call_output", call_id: `call-${i}`, output: `Process exited with code 0\nOutput:\n${i}` } },
      )
    }
    if (!bracketOnly) events.push({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Fixed the drawer" } })
    events.push({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Fixed the drawer" } })
    const messages = projectCodexTranscript(rollout(events))
    const prose = messages.filter((m) => m.role === "assistant" && !m.kind && m.text)
    assert.deepEqual(prose.map((m) => m.text), ["Tracing the drawer", "Reading the stack", "Checking the fix", "Fixed the drawer"])
    assert.equal(messages.filter((m) => m.kind === "reasoning").length, 1)
    assert.equal(messages.flatMap((m) => m.tools).length, 3)
    assert.equal(new Set(prose.map((m) => m.sourceId)).size, 4)
    assert.equal(messages.at(-1)?.boundary, "rest")
  }
})

test("real 0.144.1 exec wrapper shapes preserve cwd, yielded session, poll target, duration, and plan progress", () => {
  const exec = `const r = await tools.exec_command({
  cmd: "printf 'tick-1\\n'\nsleep 0.5\nprintf 'tick-2\\n'",
  workdir: "/tmp/frizz-tool-render-real.zikelm",
  yield_time_ms: 250,
  max_output_tokens: 2000
});
text(r);
`
  const poll = `const r = await tools.write_stdin({
  session_id: 20444,
  chars: "",
  yield_time_ms: 250,
  max_output_tokens: 2000
});
text(r);
`
  const plan = `const r = await tools.update_plan({"plan":[{"step":"one","status":"completed"},{"step":"two","status":"in_progress"}]}); text(r);`
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: exec } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" },
          { type: "input_text", text: JSON.stringify({ wall_time_seconds: 0.253269375, session_id: 20444, output: "tick-1\n" }) },
        ],
      },
    },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c2", name: "exec", input: poll } },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c2",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
          { type: "input_text", text: JSON.stringify({ wall_time_seconds: 0.000002292, exit_code: 0, output: "tick-2\n" }) },
        ],
      },
    },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c3", name: "exec", input: plan } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c3", output: "Script completed\nWall time 0.0 seconds\nOutput:\n{}" } },
  ])
  const [bash, planned] = parseCodexTranscript(raw)[0].tools
  assert.equal(bash.name, "Bash")
  assert.equal(bash.cwd, "/tmp/frizz-tool-render-real.zikelm")
  assert.equal(bash.sessionId, 20444)
  assert.ok(Math.abs((bash.durationMs ?? 0) - 253.269375) < 0.001)
  assert.equal(bash.status, "completed")
  assert.equal(bash.output, "tick-2", "poll output is grouped onto the originating shell")
  assert.equal(planned.detail, undefined, "the headline is the client's read of the list, not a server string")
  assert.deepEqual(planned.todos, [{ text: "one", status: "completed" }, { text: "two", status: "in_progress" }])
})

test("Codex yielded FOREGROUND shell remains pending until its matching session poll has an exit code", () => {
  const exec = `const r = await tools.exec_command({ cmd: "sleep 5", yield_time_ms: 10 }); text(r);`
  const poll = `const r = await tools.write_stdin({ session_id: 71, chars: "", yield_time_ms: 10 }); text(r);`
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "launch", name: "exec", input: exec } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "launch", output: `Script completed\nWall time 0.0 seconds\nOutput:\n${JSON.stringify({ session_id: 71, output: "started" })}` } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "poll", name: "exec", input: poll } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "poll", output: `Script completed\nWall time 0.0 seconds\nOutput:\n${JSON.stringify({ session_id: 71, output: "still running" })}` } },
  ])
  const tools = parseCodexTranscript(raw)[0].tools
  assert.equal(tools.length, 1, "related poll is grouped rather than rendered as another completed shell")
  assert.equal(tools[0].status, "pending")
  assert.equal(tools[0].backgroundState, undefined, "a session_id is continuation, not a background handoff")
  assert.equal(tools[0].sessionId, 71)
})

test("Codex Ctrl-C receipt with a target session id is terminal, not a background launch", () => {
  const interrupt = `const r = await tools.write_stdin({ session_id: 35985, chars: "\\u0003", yield_time_ms: 10 }); text(r);`
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "interrupt", name: "exec", input: interrupt } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "interrupt", output: `Script completed\nWall time 5.0 seconds\nOutput:\n${JSON.stringify({ session_id: 35985, output: "^C" })}` } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.deepEqual(
    { name: call.name, detail: call.detail, input: call.input, output: call.output, status: call.status, backgroundState: call.backgroundState },
    { name: "Interrupt process", detail: "session 35985", input: "Ctrl-C", output: "^C", status: "completed", backgroundState: undefined },
  )
})

test("Codex correlates simultaneous yielded sessions to their own terminal success and failure", () => {
  const exec = (cmd: string) => `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, yield_time_ms: 10 }); text(r);`
  const poll = (id: number) => `const r = await tools.write_stdin({ session_id: ${id}, chars: "", yield_time_ms: 10 }); text(r);`
  const output = (body: object) => `Script completed\nWall time 0.0 seconds\nOutput:\n${JSON.stringify(body)}`
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "a", name: "exec", input: exec("watch-a") } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "a", output: output({ session_id: 1, output: "a started" }) } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "b", name: "exec", input: exec("watch-b") } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "b", output: output({ session_id: 2, output: "b started" }) } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "pb", name: "exec", input: poll(2) } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "pb", output: output({ exit_code: 9, output: "b failed" }) } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "pa", name: "exec", input: poll(1) } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "pa", output: output({ exit_code: 0, output: "a done" }) } },
  ])
  const shells = parseCodexTranscript(raw)[0].tools.filter((call) => call.name === "Bash")
  assert.deepEqual(shells.map((call) => [call.command, call.status, call.exitCode]), [["watch-a", "completed", 0], ["watch-b", "failed", 9]])
  assert.deepEqual(shells.map((call) => call.output), ["a done", "b failed"])
})

test("Codex unpaired session poll stays background/unknown instead of falsely completing", () => {
  const poll = `const r = await tools.write_stdin({ session_id: 404, chars: "", yield_time_ms: 10 }); text(r);`
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "poll", name: "exec", input: poll } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "poll", output: `Script completed\nWall time 0.0 seconds\nOutput:\n${JSON.stringify({ exit_code: 0, output: "lost history" })}` } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.status, "pending")
  assert.equal(call.backgroundState, "unknown")
})

test("real collaboration shapes show targets/summaries, never encrypted messages, and distinguish errors", () => {
  const encrypted = "gAAAAABqU-akIizxXc0EnAT4vtESZIFClmfVfTOMv8q1siCAOyuV-UeURhiWLfpZ7TXdJiEZAqnqUO_DLc5TO4PF"
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "send", name: "send_message", arguments: JSON.stringify({ target: "/root/reviewer", message: encrypted }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "send", output: "" } },
    { type: "response_item", payload: { type: "function_call", call_id: "agents", name: "list_agents", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "agents", output: JSON.stringify({ agents: [{ agent_status: "running" }, { agent_status: { completed: "done" } }] }) } },
    { type: "response_item", payload: { type: "function_call", call_id: "spawn", name: "spawn_agent", arguments: JSON.stringify({ task_name: "reviewer", model: "gpt-5.6-sol", reasoning_effort: "high", fork_context: false, message: encrypted }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "spawn", output: "collab spawn failed: agent thread limit reached" } },
    { type: "response_item", payload: { type: "function_call", call_id: "wait", name: "wait_agent", arguments: JSON.stringify({ timeout_ms: 20_000 }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "wait", output: JSON.stringify({ message: "Wait timed out.", timed_out: true }) } },
  ])
  const [sent, agents, spawned, waited] = parseCodexTranscript(raw)[0].tools
  assert.deepEqual({ name: sent.name, detail: sent.detail, status: sent.status }, { name: "Send message", detail: "/root/reviewer", status: "completed" })
  assert.equal(sent.input, undefined)
  assert.equal(agents.output, "2 agents · 1 running · 1 completed")
  assert.equal(spawned.name, "Spawn agent")
  assert.equal(spawned.detail, "reviewer")
  assert.equal(spawned.status, "failed")
  // Model+effort ride the header's `subagentType` tag now (the codex analogue of Claude's
  // `[frizz:opus-high]`), so the dispatch cell reads at a glance instead of only inside the payload.
  assert.equal(spawned.subagentType, "gpt-5.6-sol/high")
  assert.match(spawned.input ?? "", /fork_context/)
  // This spawn was REJECTED, so no child exists: the card must not offer a drill-in that can only ever
  // resolve to "unavailable". (The tailer's tracker discards the same dispatch on the same signal.)
  assert.equal(spawned.agentId, undefined)
  assert.match(spawned.output ?? "", /thread limit reached/)
  assert.equal(waited.detail, "up to 20s")
  assert.equal(waited.output, "Timed out without an update")
  assert.doesNotMatch(JSON.stringify([sent, agents, spawned, waited]), /gAAAA|encrypted payload/)
})

// ---- a codex child REPORTING BACK (the completion notification that used to vanish) ----
// A `spawn_agent` child does not return through the parent's tool result — that only carries the spawn
// ack. It reports LATER, as an inter-agent `response_item/agent_message` addressed author → recipient.
// parseCodexLine dropped that record entirely, so a codex thread orchestrating a dozen children showed
// a run of Spawn-agent cards and then nothing ever coming back (383 dropped records in one real
// orchestration rollout). Shapes below are verbatim from that rollout.
function agentMessage(author: string, recipient: string, type: string, body: string, at?: string) {
  return {
    type: "response_item",
    ...(at ? { timestamp: at } : {}),
    payload: {
      type: "agent_message",
      author,
      recipient,
      content: [
        { type: "input_text", text: `Message Type: ${type}\nTask name: ${recipient}\nSender: ${author}\nPayload:\n${body}` },
        { type: "encrypted_content", data: "gAAAAABqbMTRjP0uenKvddqxbODpjhMbID3F" },
      ],
    },
  }
}

test("a codex child's FINAL_ANSWER draws the completion divider and back-fills its launch card", () => {
  const raw = rollout([
    { timestamp: "2026-07-11T00:00:00.000Z", type: "response_item", payload: { type: "function_call", call_id: "spawn1", name: "spawn_agent", arguments: JSON.stringify({ task_name: "release_audit", model: "gpt-5.6-terra", reasoning_effort: "medium" }) } },
    { timestamp: "2026-07-11T00:00:01.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "spawn1", output: JSON.stringify({ task_name: "/root/release_audit", nickname: "Peirce the 2nd" }) } },
    agentMessage("/root/release_audit", "/root", "FINAL_ANSWER", "**P0** — the release gate never runs `nub compile`.", "2026-07-11T00:03:20.000Z"),
  ])
  const msgs = projectCodexTranscript(raw)
  const completion = msgs.flatMap((m) => m.tools).find((t) => t.agentCompletion)
  assert.ok(completion, "the child's terminal return renders the wake divider the Claude path draws")
  assert.equal(completion.detail, "release_audit")
  assert.equal(completion.agentStatus, "completed")
  // Elapsed is dispatch → report (200s), never the spawn call's own latency.
  assert.equal(completion.agentElapsedMs, 200_000)
  // It is a COPY: the launch card keeps its own identity and is back-filled, not replaced.
  const launch = msgs.flatMap((m) => m.tools).find((t) => t.name === "Spawn agent" && !t.agentCompletion)
  assert.equal(launch?.agentStatus, "completed")
  assert.equal(completion.agentId, "spawn1", "the divider drills into the child under its DISPATCH id")
  // The divider is its own message at the position the report landed, so later parent prose renders below it.
  assert.equal(msgs.at(-1)?.tools[0]?.agentCompletion, true)
})

test("a codex child's mid-flight MESSAGE draws the peer report line, linked to its dispatch", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "spawn2", name: "spawn_agent", arguments: JSON.stringify({ task_name: "bun_survey" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "spawn2", output: JSON.stringify({ task_name: "/root/bun_survey" }) } },
    // Every MESSAGE in the reference rollout has an EMPTY plaintext payload (its text rides the
    // encrypted block), and it must STILL surface — the line renders no excerpt by design, so the
    // divider itself is the whole signal.
    agentMessage("/root/bun_survey", "/root", "MESSAGE", ""),
  ])
  const report = projectCodexTranscript(raw).find((m) => m.role === "user" && m.peerFrom)
  assert.equal(report?.peerFrom, "bun_survey")
  assert.equal(report?.peerDispatchId, "spawn2", "the DISPATCH id is what the drawer resolves")
})

test("codex inter-agent records distinguish incoming child instructions from irrelevant shapes", () => {
  // INBOUND from the child's perspective: the encrypted body cannot be shown, but the arrival itself
  // must be visible in the child drawer.
  const outbound = rollout([agentMessage("/root", "/root/bun_survey", "NEW_TASK", "")])
  assert.match(projectCodexTranscript(outbound)[0].text, /Task instructions received/)
  // A child that reports before any spawn card exists (a resumed rollout) degrades to nothing rather
  // than inventing a completion divider with no dispatch to drill into.
  const orphan = rollout([agentMessage("/root/gone", "/root", "FINAL_ANSWER", "done")])
  assert.deepEqual(projectCodexTranscript(orphan).flatMap((m) => m.tools), [])
  // An unrecognized message type is never rendered blind.
  const unknown = rollout([agentMessage("/root/x", "/root", "SOMETHING_NEW", "body")])
  assert.deepEqual(projectCodexTranscript(unknown), [])
})

test("a REJECTED codex spawn can never be credited with a later child's report", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "spawn3", name: "spawn_agent", arguments: JSON.stringify({ task_name: "platform_proof" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "spawn3", output: "collab spawn failed: agent thread limit reached" } },
    agentMessage("/root/platform_proof", "/root", "FINAL_ANSWER", "impossible — this child never existed"),
  ])
  const msgs = projectCodexTranscript(raw)
  assert.equal(msgs.flatMap((m) => m.tools).some((t) => t.agentCompletion), false)
})

test("tool payloads are bounded/redacted and call-only records remain visibly pending", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "secret", name: "exec_command", arguments: JSON.stringify({ cmd: "export FRIZZ_API_TOKEN=super-secret-value\nprintf ok" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "secret", output: "FRIZZ_API_TOKEN=leaked-value" } },
    { type: "response_item", payload: { type: "function_call", call_id: "pending", name: "web_search", arguments: JSON.stringify({ query: "rollout schema" }) } },
  ])
  const [secret, pending] = parseCodexTranscript(raw)[0].tools
  assert.equal(secret.command, "export FRIZZ_API_TOKEN=[redacted]\nprintf ok")
  assert.equal(secret.output, "FRIZZ_API_TOKEN=[redacted]")
  assert.equal(secret.status, "completed")
  assert.equal(pending.status, "pending")
})

test("CLI userinfo, secret flags, URL credentials, argv arrays, nested metadata, and result errors are redacted from every tool projection", () => {
  const fixtures = {
    user: "fixture-user-credential",
    flag: "fixture-flag-credential",
    encoded: "%66%69%78%74%75%72%65-url-credential",
    nested: "fixture-nested-credential",
    result: "fixture-result-credential",
  }
  const raw = rollout([
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "argv",
        name: "shell",
        arguments: JSON.stringify({
          command: ["curl", "-u", `alice:${fixtures.user}`, "--token", fixtures.flag, `https://bob:${fixtures.encoded}@example.test/private`],
          cwd: `https://builder:${fixtures.nested}@example.test/workspace`,
        }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "argv",
        output: `tool failed --secret=${fixtures.result}; retry https://ops:${fixtures.result}@example.test/status`,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "nested",
        name: "custom_tool",
        arguments: JSON.stringify({
          request: { argv: ["client", "--password", fixtures.nested] },
          metadata: { callback: `https://bob%3A${fixtures.encoded}@example.test/callback`, apiKey: fixtures.flag },
        }),
      },
    },
  ])
  const [argv, nested] = parseCodexTranscript(raw)[0].tools
  const rendered = JSON.stringify([argv, nested])
  for (const fixture of Object.values(fixtures)) assert.equal(rendered.includes(fixture), false, fixture)
  assert.match(argv.command ?? "", /curl -u alice:\[redacted\] --token \[redacted\]/)
  assert.match(argv.command ?? "", /https:\/\/bob:\[redacted\]@example\.test\/private/)
  assert.match(argv.cwd ?? "", /https:\/\/builder:\[redacted\]@example\.test\/workspace/)
  assert.match(argv.output ?? "", /--secret=\[redacted\].*https:\/\/ops:\[redacted\]@example\.test/)
  assert.match(nested.input ?? "", /"argv": \[/)
  assert.match(nested.input ?? "", /"--password"/)
  assert.match(nested.input ?? "", /"\[redacted\]"/)
})

test("JSON-quoted credentials, padded ciphertext, JWTs, and structured result errors never reach transcript cards", () => {
  const encrypted = `gAAAAABq${"A".repeat(60)}==`
  const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`
  const raw = rollout([
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "secret-json",
        name: "custom_tool",
        arguments: JSON.stringify({ headers: { Authorization: "Bearer top-secret-value" }, FRIZZ_API_TOKEN: "json-secret-value", token: "bare-token-value", credential: "credential-value", encrypted, jwt }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "secret-json",
        output: JSON.stringify({ error: "FRIZZ_API_TOKEN=result-secret-value", Authorization: "Bearer result-token" }),
      },
    },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.status, "failed")
  const rendered = JSON.stringify(call)
  assert.doesNotMatch(rendered, /top-secret|json-secret|bare-token|credential-value|result-secret|result-token|gAAAA|={2}|eyJ/)
  assert.match(rendered, /encrypted payload/)
  assert.match(rendered, /redacted/)
})

test("unified wrappers honor structured and plain nested failures even when the JavaScript wrapper completed", () => {
  const structured = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "structured", name: "exec", input: `const r = await tools.custom({}); text(r);` } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "structured", output: `Script completed\nWall time 0.1 seconds\nOutput:\n${JSON.stringify({ error: "nested failure" })}` } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "plain", name: "exec", input: `const r = await tools.custom({}); text(r);` } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "plain", output: "Script completed\nWall time 0.1 seconds\nOutput:\nverification failed: mismatch" } },
  ])
  const [structuredCall, plainCall] = parseCodexTranscript(structured)[0].tools
  assert.equal(structuredCall.status, "failed")
  assert.equal(plainCall.status, "failed")
  assert.match(plainCall.output ?? "", /verification failed/)
})

test("successful prose containing failed or killed is not misclassified as a tool failure/cancellation", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "tests", name: "custom_tool", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "tests", output: "0 failed, 12 passed" } },
    { type: "response_item", payload: { type: "function_call", call_id: "docs", name: "custom_tool", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "docs", output: "Documentation: processes killed by policy are retried" } },
  ])
  const [tests, docs] = parseCodexTranscript(raw)[0].tools
  assert.equal(tests.status, "completed")
  assert.equal(docs.status, "completed")
})

test("exec wrapper scanning ignores tools-like text in comments", () => {
  const source = `// tools.apply_patch("not a call")\nconst r = await tools.exec_command({cmd:"pwd",workdir:"/tmp/fixture"}); text(r);`
  const [call] = parseCodexTranscript(rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "comment", name: "exec", input: source } },
  ]))[0].tools
  assert.equal(call.name, "Bash")
  assert.equal(call.command, "pwd")
  assert.equal(call.cwd, "/tmp/fixture")
})

test("real wrapped web and image calls expose the query/path without image blobs", () => {
  const search = `const r = await tools.web__run({search_query:[{q:"Codex rollout schema"}],response_length:"short"}); text(r);`
  const view = `const r = await tools.view_image({path:"/tmp/evidence.png",detail:"original"}); image(r.image_url);`
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "search", name: "exec", input: search } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "search", output: "Script completed\nWall time 0.1 seconds\nOutput:\nsearch result" } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "view", name: "exec", input: view } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "view", output: "Script completed\nWall time 0.1 seconds\nOutput:\n[image output]" } },
  ])
  const [web, image] = parseCodexTranscript(raw)[0].tools
  assert.equal(web.name, "Search web")
  assert.equal(web.detail, "Codex rollout schema")
  assert.equal(web.output, "search result")
  assert.equal(image.name, "View image")
  assert.equal(image.detail, "/tmp/evidence.png")
  assert.equal(image.output, undefined)
  assert.equal(image.status, "completed")
  // No such file on disk → no picture to show, and NOT a broken <img>: the card degrades to its header.
  assert.equal(image.outputImage, undefined)
})

// A minimal well-formed rollout builder for synthetic shapes (session_meta is sidecar → skipped).
function rollout(lines: Array<{ type: string; payload?: Record<string, unknown>; timestamp?: string }>): string {
  return lines.map((l) => JSON.stringify({ timestamp: "2026-07-11T00:00:00.000Z", ...l })).join("\n")
}

// ---- view_image renders the PICTURE, not a "[image output]" placeholder ----
// Codex ships the viewed image back as an `input_image` data URL, which backend/codex collapses to the
// "[image output]" placeholder (never pump base64 through the tailer). The card recovers the picture from
// the call's own `path` instead, copying it into the servable screenshot cache.
// Two DISTINCT minimal 1×1 PNGs — both decode to real png bytes, so the magic-byte gate accepts either
// and a byte comparison can tell one card's snapshot from another's.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const PNG_1x1_ALT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

function writeTempPng(name: string, b64 = PNG_1x1): string {
  const path = join(mkdtempSync(join(tmpdir(), "frizz-view-image-")), name)
  writeFileSync(path, Buffer.from(b64, "base64"))
  return path
}

// One direct view_image function_call + its input_image result, projected to the single tool card.
// `callId` must be unique per case: the cache filename derives from it, so a reused id (correctly)
// short-circuits on existsSync and hands back an earlier case's copy.
function viewImageTool(callId: string, path: string) {
  return parseCodexTranscript(rollout([
    { type: "response_item", payload: { type: "function_call", call_id: callId, name: "view_image", arguments: JSON.stringify({ path }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: callId, output: [{ type: "input_image", image_url: "data:image/png;base64,x" }] } },
  ]))[0].tools[0]
}

// The legacy `function_call` form — what codex 0.144.1 actually emits for view_image. Before this case
// existed the card fell to the generic branch: raw snake_case name, no picture, and a body whose entire
// content was the literal string "[image output]".
test("a direct view_image function_call renders the picture inline, never an '[image output]' placeholder", () => {
  const path = writeTempPng("evidence.png")
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "vi1", name: "view_image", arguments: JSON.stringify({ path, detail: "high" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "vi1", output: [{ type: "input_image", image_url: `data:image/png;base64,${PNG_1x1}` }] } },
  ])
  const [call] = parseCodexTranscript(raw)[0].tools
  assert.equal(call.name, "View image")
  assert.equal(call.detail, path)
  assert.equal(call.status, "completed")
  assert.equal(call.output, undefined, "the placeholder is suppressed — the picture is the content")
  assert.ok(call.outputImage, "outputImage is set")
  assert.match(call.outputImage!, /frizz-tool-images-[0-9a-f]{16}[/\\][0-9a-f]{32}\.png$/)
  // The cache copy holds the source bytes verbatim, so /local-image serves the real picture.
  assert.deepEqual(readFileSync(call.outputImage!), Buffer.from(PNG_1x1, "base64"))
})

// The one view_image that stays a plain header: the human's own prompt attachment, whose picture their
// bubble already shows. Mirrors the Claude Read gate (transcript.test.ts). The file is REAL and readable
// under a throwaway HOME (the memoized roots are reset around it), so the only thing that can leave
// `outputImage` unset is the gate itself — a missing file would pass this vacuously.
test("a view_image of a prompt attachment keeps its plain header instead of repeating the picture", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-attach-home-"))
  const savedHome = process.env.HOME
  process.env.HOME = home
  resetFrizzRoots()
  try {
    const dir = join(projectStateDir("029a30af-f126-40e3-b04c-d80e74e3e090"), "attachments")
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "1787867365865-f12df6c2-Screenshot-2026-08-27-at-14-49-15.png")
    writeFileSync(path, Buffer.from(PNG_1x1, "base64"))
    const call = viewImageTool("vi-attachment", path)
    assert.equal(call.name, "View image")
    assert.equal(call.detail, path)
    assert.equal(call.status, "completed")
    assert.equal(call.outputImage, undefined, "the human's own attachment is not repeated on the card")
    // Control under the SAME roots: the identical bytes anywhere else still render.
    const elsewhere = join(home, "board.png")
    writeFileSync(elsewhere, Buffer.from(PNG_1x1, "base64"))
    assert.ok(viewImageTool("vi-attachment-control", elsewhere).outputImage, "a picture outside attachments/ still renders")
  } finally {
    process.env.HOME = savedHome
    resetFrizzRoots()
    rmSync(home, { recursive: true, force: true })
  }
})

// WHY the card serves a COPY rather than the source path (/local-image would serve either — it is
// unconfined): a worker iterating on a screenshot overwrites ONE path repeatedly, so rendering the live
// file would show every view in that loop the final image. Each call snapshots its own bytes instead.
test("re-viewing an OVERWRITTEN path shows each view's own bytes, not the final file", () => {
  const path = writeTempPng("iterated.png")
  const first = viewImageTool("vi2a", path)
  // The worker re-shoots to the same path and views it again — a different picture under the same name.
  writeFileSync(path, Buffer.from(PNG_1x1_ALT, "base64"))
  const second = viewImageTool("vi2b", path)
  assert.ok(first.outputImage && second.outputImage)
  assert.notEqual(first.outputImage, second.outputImage, "each call gets its own cache entry")
  assert.deepEqual(readFileSync(first.outputImage!), Buffer.from(PNG_1x1, "base64"), "the first card still shows the ORIGINAL")
  assert.deepEqual(readFileSync(second.outputImage!), Buffer.from(PNG_1x1_ALT, "base64"))
})

test("a view_image of a path that no longer exists degrades to a header-only card", () => {
  const call = viewImageTool("vi3", "/tmp/frizz-does-not-exist-9137.png")
  assert.equal(call.name, "View image")
  assert.equal(call.outputImage, undefined)
  assert.equal(call.output, undefined, "still no '[image output]' placeholder body")
})

// Codex's OTHER tool protocol — the unified exec wrapper's `tools.view_image({path})` — reaches the same
// card. This form already carried the "View image" label; what it lacked was the picture.
test("the exec-wrapper view_image form also renders the picture", () => {
  const path = writeTempPng("wrapped.png")
  const source = `const r = await tools.view_image({path:${JSON.stringify(path)},detail:"original"}); image(r.image_url);`
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "vi4", name: "exec", input: source } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "vi4", output: "Script completed\nWall time 0.1 seconds\nOutput:\n[image output]" } },
  ])
  const [call] = parseCodexTranscript(raw)[0].tools
  assert.equal(call.name, "View image")
  assert.equal(call.detail, path)
  assert.ok(call.outputImage)
  assert.deepEqual(readFileSync(call.outputImage!), Buffer.from(PNG_1x1, "base64"))
})

test("a view_image of a NON-image path is not served as a picture", () => {
  const path = join(mkdtempSync(join(tmpdir(), "frizz-view-image-")), "notes.txt")
  writeFileSync(path, "not a picture")
  const call = viewImageTool("vi5", path)
  assert.equal(call.name, "View image")
  assert.equal(call.outputImage, undefined)
})

// A .png name over non-png bytes must never reach the page as a broken <img>.
test("a view_image whose bytes are not the image its extension claims is skipped", () => {
  const path = writeTempPng("liar.png")
  writeFileSync(path, "GIF89a-but-named-png")
  const call = viewImageTool("vi6", path)
  assert.equal(call.outputImage, undefined, "magic-byte mismatch → header-only, not a broken picture")
})

test("codex reasoning: a turn's SEVERAL reasoning steps COALESCE into one expandable block above the work", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "user_message", message: "why is the sky blue?" } },
    { type: "response_item", payload: { type: "reasoning", encrypted_content: "gAAAAAB-blob", summary: [{ type: "summary_text", text: "**Recalling Rayleigh scattering**" }] } },
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo hi" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "hi" } },
    // A SECOND reasoning step, AFTER a tool call — it must fold into the SAME block, not spawn a new one.
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "**Confirming the wavelength math**" }] } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Rayleigh scattering." } },
  ])
  const msgs = parseCodexTranscript(raw)
  const reasoningMsgs = msgs.filter((m) => m.kind === "reasoning")
  assert.equal(reasoningMsgs.length, 1, "both steps coalesce into ONE reasoning block")
  const reasoning = reasoningMsgs[0]
  assert.equal(reasoning.role, "assistant")
  // Both steps present, joined with a blank line, in order.
  assert.equal(reasoning.text, "**Recalling Rayleigh scattering**\n\n**Confirming the wavelength math**")
  assert.equal(reasoning.tools.length, 0)
  assert.ok(!reasoning.text.includes("gAAAA"), "encrypted CoT never leaks")
  // The block sits ABOVE the work; the tool + answer render in fresh message(s) below it.
  assert.equal(msgs.indexOf(reasoning), 1, "reasoning block leads the turn (after the user bubble)")
  const work = msgs.filter((m) => m.kind === undefined && m.role === "assistant")
  assert.ok(work.some((m) => m.tools[0]?.command === "echo hi"), "the tool renders below the reasoning block")
  assert.ok(work.some((m) => /Rayleigh scattering/.test(m.text)), "the answer renders below the reasoning block")
})

test("codex reasoning: durationMs sums each step's thinking gap and EXCLUDES tool-execution time", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 6, 11, 0, 0, s)).toISOString()
  const line = (timestamp: string, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp, type, payload })
  const raw = [
    line(at(0), "event_msg", { type: "task_started" }),
    line(at(0), "event_msg", { type: "user_message", message: "go" }),
    line(at(5), "response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "**Step one**" }] }), // +5s thinking (from user turn)
    line(at(5), "response_item", { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" }),
    line(at(25), "response_item", { type: "function_call_output", call_id: "c1", output: "ok" }), // 20s TOOL run — must NOT count
    line(at(33), "response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "**Step two**" }] }), // +8s thinking (from tool output)
    line(at(34), "event_msg", { type: "agent_message", phase: "final_answer", message: "done" }),
  ].join("\n")
  const reasoning = parseCodexTranscript(raw).find((m) => m.kind === "reasoning")!
  assert.equal(reasoning.durationMs, 13_000, "5s + 8s of thinking; the 20s tool run between them is excluded")
})

test("codex reasoning: a NEW turn (turn-start / human follow-up) starts a FRESH reasoning block", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "first" } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "**Turn one thought**" }] } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "one" } },
    { type: "event_msg", payload: { type: "user_message", message: "second" } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "**Turn two thought**" }] } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "two" } },
  ])
  const reasoningMsgs = parseCodexTranscript(raw).filter((m) => m.kind === "reasoning")
  assert.equal(reasoningMsgs.length, 2, "each turn gets its own reasoning block")
  assert.equal(reasoningMsgs[0].text, "**Turn one thought**")
  assert.equal(reasoningMsgs[1].text, "**Turn two thought**")
})

test("codex reasoning with empty summary (encryption-only) → NO reasoning message (behavior preserved)", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { type: "response_item", payload: { type: "reasoning", encrypted_content: "gAAAAAB-blob", summary: [] } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "hello" } },
  ])
  const msgs = parseCodexTranscript(raw)
  assert.ok(!msgs.some((m) => m.kind === "reasoning"), "no reasoning block when the summary is empty")
})

test("codex apply_patch (Add File) → an Edit diff card (old empty, new = added lines)", () => {
  const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+export const x = 1", "+export const y = 2", "*** End Patch"].join("\n")
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "make the file" } },
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "apply_patch", arguments: JSON.stringify({ input: patch }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Success. Updated the file src/new.ts" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "done" } },
  ])
  const msgs = parseCodexTranscript(raw)
  const call = msgs[1].tools[0]
  assert.equal(call.name, "Edit")
  assert.equal(call.edit?.file, "src/new.ts")
  assert.equal(call.edit?.old, "")
  assert.equal(call.edit?.new, "export const x = 1\nexport const y = 2")
})

test("codex apply_patch (Update File) → an Edit diff card (old/new reconstructed from the hunk)", () => {
  const patch = ["*** Begin Patch", "*** Update File: a.txt", "@@", " keep", "-old line", "+new line", "*** End Patch"].join("\n")
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "apply_patch", arguments: JSON.stringify({ input: patch }) } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.name, "Edit")
  assert.equal(call.edit?.file, "a.txt")
  assert.equal(call.edit?.old, "keep\nold line")
  assert.equal(call.edit?.new, "keep\nnew line")
})

test("codex `shell` tool with an argv command (['bash','-lc','<script>']) → the script as the Bash command", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "grep -r foo ."] }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Chunk ID: x\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nfoo\n" } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.name, "Bash")
  assert.equal(call.command, "grep -r foo .")
  assert.equal(call.output, "foo")
})

test("codex non-zero exit → the output pane is prefixed with [exit N]", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "false" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Chunk ID: x\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n" } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  assert.equal(call.command, "false")
  assert.equal(call.output, "[exit 1]")
})

test("codex unknown tool degrades to a generic card (name + a hint), never a throw or blank", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "web_search", arguments: JSON.stringify({ query: "codex rollout schema" }) } },
  ])
  const call = parseCodexTranscript(raw)[0].tools[0]
  // The card is still the GENERIC one (no command, no edit) — but an unrecognized codex tool is now
  // titled by its sentence-cased name rather than by the raw snake_case identifier.
  assert.equal(call.name, "Web search")
  assert.equal(call.detail, "codex rollout schema")
  assert.equal(call.command, undefined)
  assert.equal(call.edit, undefined)
})

test("codex first user message preserves the task while stripping only Frizz dispatch scaffolding, title trailer, and sentinel", () => {
  const composed = `WORKER CONTRACT stuff\n\nscratchpad orientation\n\nSome preamble\nTASK:\nActually do the thing\n\n${CODEX_FIRST_FINAL_TITLE_TRANSPORT}\n\n<!-- frizz-session:01234567-89ab-cdef-0123-456789abcdef -->`
  const raw = rollout([{ type: "event_msg", payload: { type: "user_message", message: composed } }])
  const msgs = parseCodexTranscript(raw)
  // The dispatch scaffolding is a DISPLAY projection: the bubble is the task, the stored text keeps the
  // machine-facing prompt. (The title trailer and sentinel are genuinely removed — they are Frizz's own
  // transport, not something the worker was ever meant to read back.)
  assert.equal(msgs[0].displayText, "Actually do the thing")
  assert.match(msgs[0].text, /^WORKER CONTRACT stuff/)
  assert.doesNotMatch(msgs[0].text, /FRIZZ TITLE TRANSPORT|frizz-session:/)
})

test("codex first user message strips the exact legacy H1 title trailer without rewriting old transcripts", () => {
  const task = "Keep this human task exactly as written."
  const composed = `WORKER CONTRACT stuff\n\nTASK:\n${task}\n\n${CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT}\n\n<!-- frizz-session:01234567-89ab-cdef-0123-456789abcdef -->`
  const [message] = parseCodexTranscript(rollout([{ type: "event_msg", payload: { type: "user_message", message: composed } }]))
  assert.equal(message.displayText, task)
  assert.doesNotMatch(message.text, /FRIZZ TITLE TRANSPORT|# Title/)

  const almostGenerated = `${task}\n\n${CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT}\n\n<!-- frizz-session:not-a-uuid -->`
  const [ordinary] = parseCodexTranscript(rollout([{ type: "event_msg", payload: { type: "user_message", message: `contract\nTASK:\n${almostGenerated}` } }]))
  // The general sentinel stripper still hides the discovery comment, but the invalid UUID must not
  // authorize removal of the adjacent title-looking human prose.
  assert.equal(ordinary.displayText, `${task}\n\n${CODEX_LEGACY_FIRST_FINAL_TITLE_TRANSPORT}`)
})

test("codex first user message retains ordinary title-transport-like prose", () => {
  const task = `${CODEX_FIRST_FINAL_TITLE_TRANSPORT}\n\nThis sentence is part of the human task.`
  const raw = rollout([{ type: "event_msg", payload: { type: "user_message", message: `contract\nTASK:\n${task}\n\n<!-- frizz-session:01234567-89ab-cdef-0123-456789abcdef -->` } }])
  const [message] = parseCodexTranscript(raw)
  assert.equal(message.displayText, task)
})

test("codex GitHub dispatch keeps the full worker tail in text and presents the compact lead", () => {
  const task = `THREAD: review-cli-cli-13844

Investigate this issue and make recommendations

PR #13844: perf(status): O(1) map lookup
Repository: cli/cli
URL: https://github.com/cli/cli/pull/13844

${GITHUB_DISPATCH_UI_BOUNDARY}

Adversarially audit the full diff, tests, and CI. This machine tail stays in the transcript.`
  const composed = `worker contract\n\nTASK:\n${task}\n\n<!-- frizz-session:abc-123 -->`
  const [message] = parseCodexTranscript(rollout([{ type: "event_msg", payload: { type: "user_message", message: composed } }]))
  // Both envelopes peel for display — frizz's dispatch scaffolding, then the GitHub template.
  assert.equal(
    message.displayText,
    "Investigate this issue and make recommendations\n\nPR #13844: perf(status): O(1) map lookup\nRepository: cli/cli\nURL: https://github.com/cli/cli/pull/13844",
  )
  assert.match(message.text, /machine tail stays in the transcript/)
  assert.doesNotMatch(message.displayText!, /machine tail|github-dispatch-ui-boundary/)
})

test("codex wake delivery hides the wake token in the bubble while the stored text keeps it", () => {
  // Codex takes the SAME deliveryMessage over the app-server bridge, so it leaks the same way.
  const steer = "⏳ The session usage limit that interrupted you has reset. Continue exactly where you left off."
  const delivered = `${steer}\n\n${wakeDeliveryToken("e9590807642cfee10b251fa5c230e3ba27f02f978475d883411a5c35e81d68c0")}`
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "contract\nTASK:\nthe task\n\n<!-- frizz-session:s1 -->" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "ok" } },
    { type: "event_msg", payload: { type: "user_message", message: delivered } },
  ])
  const msgs = parseCodexTranscript(raw)
  const wake = msgs[msgs.length - 1]
  assert.equal(wake.role, "user")
  assert.equal(wake.text, delivered)
  assert.equal(wake.displayText, steer)
})

test("codex follow-up (resume) user message renders in full (no first-message strip, no sentinel)", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "first\nTASK:\nthe task\n\n<!-- frizz-session:s1 -->" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "ok" } },
    { type: "event_msg", payload: { type: "user_message", message: "now also handle the edge case" } },
  ])
  const msgs = parseCodexTranscript(raw)
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user"],
  )
  assert.equal(msgs[0].displayText, "the task")
  assert.equal(msgs[2].text, "now also handle the edge case")
  assert.equal(msgs[2].displayText, undefined, "a follow-up carries no dispatch envelope to project out")
})

test("codex turn-end fallback: a commentary-only turn's answer (only on task_complete) is surfaced, not dropped", () => {
  // A turn that emits commentary but NO agent_message/final_answer, whose real answer rides only
  // task_complete.last_agent_message. Gating on sawFinalAnswer (not "any text") keeps this from being
  // suppressed by the commentary, while the ordinary echo case still never double-renders.
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "do it" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "working on it" } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "the real answer" } },
  ])
  const msgs = parseCodexTranscript(raw)
  const a = msgs.find((m) => m.role === "assistant")!
  assert.match(a.text, /working on it/)
  assert.equal(msgs.at(-2)?.text, "the real answer") // independent of the commentary, never dropped
})

test("codex turn-end: the ordinary case never double-renders the final answer echoed on task_complete", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "the answer" } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "the answer" } },
  ])
  const a = parseCodexTranscript(raw).find((m) => m.role === "assistant")!
  assert.equal(a.text, "the answer") // exactly once
})

// ---- context compaction (the provider-neutral divider; claude's half lives in transcript.test.ts) ----

const tokenCount = (total: number, at: string) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total } } }, timestamp: at })
const compacted = (at: string) => ({ type: "compacted", payload: { message: "", replacement_history: [] }, timestamp: at })

test("codex compaction renders a boundary divider bracketed by the token readings either side of it", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "user_message", message: "keep going" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "before the squeeze" } },
    tokenCount(242492, "2026-07-11T00:10:00.000Z"),
    compacted("2026-07-11T00:11:00.000Z"),
    tokenCount(37045, "2026-07-11T00:12:00.000Z"),
    { type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "after the squeeze" } },
  ])
  const msgs = parseCodexTranscript(raw)
  const i = msgs.findIndex((m) => m.kind === "event")
  assert.ok(i > 0, "the compaction emits a message")
  assert.equal(msgs[i].boundary, "compaction") // the centered divider rule, not a quiet inline label — and named as a compaction, so it never takes the shell glyph a `wake` boundary wears
  assert.equal(msgs[i].text, "Context compacted — 242k → 37k tokens")
  assert.equal(msgs[i].at, "2026-07-11T00:11:00.000Z") // positioned at the compaction, not at the reading after it
  // Compaction lands MID-turn: the text either side of it must stay on its own side of the divider.
  assert.equal(msgs[i - 1].text, "before the squeeze")
  assert.equal(msgs[i + 1].text, "after the squeeze")
})

test("codex compaction with no usable readings degrades to the bare label (never a fabricated bracket)", () => {
  // No token_count before → nothing to compare; and a reading that did not SHRINK is stale, not evidence
  // (one rollout in 2282 across the corpus reports the same number twice).
  const noPre = parseCodexTranscript(rollout([compacted("2026-07-11T00:11:00.000Z"), tokenCount(37045, "2026-07-11T00:12:00.000Z")]))
  assert.equal(noPre[0].text, "Context compacted")
  const unshrunk = parseCodexTranscript(
    rollout([tokenCount(13222, "2026-07-11T00:10:00.000Z"), compacted("2026-07-11T00:11:00.000Z"), tokenCount(13222, "2026-07-11T00:12:00.000Z")]),
  )
  assert.equal(unshrunk[0].text, "Context compacted")
})

test("codex reasoning after a compaction opens a FRESH block below the divider", () => {
  const raw = rollout([
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "**Before**" }] } },
    tokenCount(242492, "2026-07-11T00:10:00.000Z"),
    compacted("2026-07-11T00:11:00.000Z"),
    tokenCount(37045, "2026-07-11T00:12:00.000Z"),
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "**After**" }] } },
  ])
  const msgs = parseCodexTranscript(raw)
  const kinds = msgs.map((m) => `${m.kind}:${m.text}`)
  assert.deepEqual(kinds, ["reasoning:**Before**", "event:Context compacted — 242k → 37k tokens", "reasoning:**After**"])
})

test("codex parser is defensive: empty input, blank/malformed lines, and sidecar-only records → no throw", () => {
  assert.deepEqual(parseCodexTranscript(""), [])
  assert.deepEqual(parseCodexTranscript("\n  \nnot json\n{bad"), [])
  // session_meta / token_count / reasoning / the raw response_item/message echo are all sidecar → nothing.
  const sidecar = rollout([
    { type: "session_meta", payload: { session_id: "s", cwd: "/tmp" } },
    { type: "event_msg", payload: { type: "token_count", info: {} } },
    { type: "response_item", payload: { type: "reasoning", content: "secret" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "echo dup" }] } },
  ])
  assert.deepEqual(parseCodexTranscript(sidecar), [])
})

test("Codex pagination uses the uncapped provider-neutral projection and walks one user turn per page", () => {
  const records: Array<{ type: string; payload: Record<string, unknown> }> = []
  for (let i = 0; i < 155; i++) {
    records.push({ type: "event_msg", payload: { type: "user_message", message: `user-${i}` } })
    records.push({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: `assistant-${i}` } })
  }
  const projected = projectCodexTranscript(rollout(records), "codex:test-session")
  assert.equal(projected.length, 310, "pagination projects before applying the ordinary 300-message presentation cap")
  const first = pageProjectedTranscript(projected, projected.length)
  const second = pageProjectedTranscript(projected, first.start)
  assert.deepEqual(first.messages.map((message) => message.text), ["user-154", "assistant-154"])
  assert.deepEqual(second.messages.map((message) => message.text), ["user-153", "assistant-153"])
})

// ---- an MCP take_screenshot renders the SHOT ----
// Unlike view_image, a screenshot taken without `filePath` exists ONLY as the base64 data URL on its
// result — there is no file to fall back to, so losing it in parsing loses the picture outright.

function screenshotRollout(callId: string, args: Record<string, unknown>, imageUrl: string | null, resultText = "Took a screenshot of the current page's viewport.") {
  const output: Array<Record<string, unknown>> = [
    { type: "input_text", text: "Wall time: 0.0580 seconds\nOutput:" },
    { type: "input_text", text: resultText },
  ]
  if (imageUrl) output.push({ type: "input_image", image_url: imageUrl })
  return rollout([
    { type: "response_item", payload: { type: "function_call", call_id: callId, name: "take_screenshot", namespace: "mcp__chrome_devtools", arguments: JSON.stringify(args) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: callId, output } },
  ])
}

test("an MCP take_screenshot decodes its inline shot and drops the '[image output]' stand-in", () => {
  const [call] = parseCodexTranscript(screenshotRollout("shot1", { pageId: 1, format: "png" }, `data:image/png;base64,${PNG_1x1}`))[0].tools
  assert.equal(call.name, "Screenshot")
  // Before: the generic branch rendered `take_screenshot` captioned "png" — toolDetail's first-string-field
  // fallback had picked the `format` arg, labelling every shot with its file extension.
  assert.equal(call.detail, "viewport")
  assert.ok(call.outputImage, "the shot is decoded to a servable path")
  assert.match(call.outputImage!, /frizz-tool-images-[0-9a-f]{16}[/\\][0-9a-f]{32}\.png$/)
  assert.deepEqual(readFileSync(call.outputImage!), Buffer.from(PNG_1x1, "base64"))
  // The wall-time envelope duplicates the card's own duration meta, and the stand-in captions a picture
  // the reader can now see. Only the real sentence survives — and the duration still parses out of it.
  assert.equal(call.output, "Took a screenshot of the current page's viewport.")
  assert.equal(call.durationMs, 58)
})

test("a full-page screenshot says so instead of naming its file format", () => {
  const [call] = parseCodexTranscript(screenshotRollout("shot2", { pageId: 1, format: "png", fullPage: true }, `data:image/png;base64,${PNG_1x1}`, "Took a screenshot of the full current page."))[0].tools
  assert.equal(call.detail, "full page")
  assert.ok(call.outputImage)
})

test("a screenshot that FAILED shows its error, not a picture", () => {
  const denied = '[{"type":"text","text":"Error: Access denied: path /nope.png is not within any of the configured workspace roots."}]'
  const [call] = parseCodexTranscript(screenshotRollout("shot3", { pageId: 1, filePath: "/nope.png" }, null, denied))[0].tools
  assert.equal(call.name, "Screenshot")
  assert.equal(call.detail, "/nope.png")
  assert.equal(call.outputImage, undefined, "no inline image and no such file on disk")
  assert.match(call.output ?? "", /Access denied/)
})

test("a screenshot data URL of an unservable type (svg) is skipped, never mislabelled png", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64")
  const [call] = parseCodexTranscript(screenshotRollout("shot4", { pageId: 1 }, `data:image/svg+xml;base64,${svg}`))[0].tools
  assert.equal(call.outputImage, undefined)
})

test("a screenshot data URL whose bytes are not the type it claims is skipped (no broken img)", () => {
  const garbage = Buffer.from("definitely not a png").toString("base64")
  const [call] = parseCodexTranscript(screenshotRollout("shot5", { pageId: 1 }, `data:image/png;base64,${garbage}`))[0].tools
  assert.equal(call.outputImage, undefined)
})

// REGRESSION GUARD for the display-side envelope strip: the exec wrapper's own
// "Script completed / Wall time / Output:" envelope is parsed by unifiedToolResult and must be
// untouched by it — status, exit code and body all exactly as before.
test("the exec-wrapper envelope still parses unchanged (status, exit code, body)", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "e1", name: "exec", input: `const r = await tools.exec_command({cmd:"ls"}); text(r);` } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "e1", output: `Script completed\nWall time: 1.5 seconds\nOutput:\n${JSON.stringify({ exit_code: 0, output: "a.txt\nb.txt" })}` } },
  ])
  const [call] = parseCodexTranscript(raw)[0].tools
  assert.equal(call.name, "Bash")
  assert.equal(call.status, "completed")
  assert.equal(call.exitCode, 0)
  assert.equal(call.output, "a.txt\nb.txt")
})

test("an escaped SESSION_ID wrapper owns later direct polls instead of minting UNKNOWN cards", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "launch", name: "exec", input: `const r = await tools.exec_command({cmd:"nub ci-watch"}); text("SESSION_ID=" + r.session_id);` } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "launch", output: "Script completed\nWall time: 1.0 seconds\nOutput:\nSESSION_ID=30796" } },
    { type: "response_item", payload: { type: "function_call", call_id: "poll", name: "write_stdin", arguments: JSON.stringify({ session_id: 30796, chars: "", yield_time_ms: 30000 }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "poll", output: "Chunk ID: done\nWall time: 2.0 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\ngreen\n" } },
  ])
  const tools = parseCodexTranscript(raw)[0].tools
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "Bash")
  assert.equal(tools[0].sessionId, 30796)
  assert.equal(tools[0].status, "completed")
  assert.equal(tools[0].backgroundState, undefined)
  assert.match(tools[0].output ?? "", /green/)
})

// ---- The DIRECT (unified-exec) tool protocol renders like the wrapper protocol ----
// Codex ships two generations of the same tools. The wrapper form (`exec` custom_tool_call carrying JS)
// had cases for write_stdin/exec_command; the direct `function_call` form did not, so its polls fell to
// the generic tail and rendered as cards literally named `write_stdin` — 4706 of them across 386 real
// rollouts, second only to Bash, because 96.9% of write_stdin calls send chars:"" purely to poll.
test("codex direct-form stdin polls fold into the command that yielded, and never mint their own card", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run build", workdir: "/repo" }) } },
    // A command that YIELDS announces its session where an exit code would go — the slot nothing read.
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Chunk ID: aa11\nWall time: 1.0 seconds\nProcess running with session ID 53228\nOriginal token count: 3\nOutput:\nbuilding…\n" } },
    { type: "response_item", payload: { type: "function_call", call_id: "p1", name: "write_stdin", arguments: JSON.stringify({ session_id: 53228, chars: "", yield_time_ms: 30000 }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "p1", output: "Chunk ID: bb22\nWall time: 30.0 seconds\nProcess running with session ID 53228\nOriginal token count: 5\nOutput:\nstill going…\n" } },
    { type: "response_item", payload: { type: "function_call", call_id: "p2", name: "write_stdin", arguments: JSON.stringify({ session_id: 53228, chars: "", yield_time_ms: 30000 }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "p2", output: "Chunk ID: cc33\nWall time: 2.0 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\ndone\n" } },
  ])
  const tools = parseCodexTranscript(raw)[0].tools
  // ONE card for the whole lifecycle: the command, not the command plus two polls.
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "Bash")
  assert.equal(tools[0].command, "npm run build")
  assert.equal(tools[0].sessionId, 53228)
  // The exit arrived on the final poll, so the command reads completed rather than forever-running.
  assert.equal(tools[0].status, "completed")
  assert.doesNotMatch(JSON.stringify(tools), /write_stdin/)
})

// A real Ctrl-C is a control action the reader wants to see, so it stays a card of its own.
test("codex direct-form write_stdin that actually writes stays visible, and Ctrl-C reads as an interrupt", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "k", name: "write_stdin", arguments: JSON.stringify({ session_id: 7, chars: "\u0003" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "k", output: "Chunk ID: dd44\nWall time: 0.1 seconds\nProcess exited with code 130\nOriginal token count: 0\nOutput:\n" } },
    { type: "response_item", payload: { type: "function_call", call_id: "w", name: "write_stdin", arguments: JSON.stringify({ session_id: 7, chars: "yes\n" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "w", output: "Chunk ID: ee55\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 0\nOutput:\n" } },
  ])
  const tools = parseCodexTranscript(raw)[0].tools
  assert.deepEqual(tools.map((t) => t.name), ["Interrupt process", "Write stdin"])
  assert.match(tools[1].input ?? "", /yes/)
})

// The `wait`/cell generation is the same shape one protocol older. Its ids are an INDEPENDENT counter
// from PTY session ids and the two co-occur in one rollout, so the registry must keep them apart.
test("codex `wait` polls fold into their script, and a cell id never resolves to the same-numbered session", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "s1", name: "exec_command", arguments: JSON.stringify({ cmd: "./long-script.sh" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "s1", output: "Chunk ID: a1\nWall time: 1.0 seconds\nScript running with cell ID 49\nOriginal token count: 0\nOutput:\n" } },
    { type: "response_item", payload: { type: "function_call", call_id: "w1", name: "wait", arguments: JSON.stringify({ cell_id: 49, yield_time_ms: 10000, max_tokens: 500 }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "w1", output: "Chunk ID: a2\nWall time: 9.0 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nfinished\n" } },
    // A DIFFERENT mechanism that happens to reuse the number 49 as a PTY session id. It must not attach
    // to the script above, and its own poll must find IT rather than the script.
    { type: "response_item", payload: { type: "function_call", call_id: "s2", name: "exec_command", arguments: JSON.stringify({ cmd: "tail -f log" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "s2", output: "Chunk ID: b1\nWall time: 1.0 seconds\nProcess running with session ID 49\nOriginal token count: 0\nOutput:\n" } },
    { type: "response_item", payload: { type: "function_call", call_id: "p3", name: "write_stdin", arguments: JSON.stringify({ session_id: 49, chars: "" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "p3", output: "Chunk ID: b2\nWall time: 1.0 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\ntailed\n" } },
  ])
  const tools = parseCodexTranscript(raw)[0].tools
  assert.deepEqual(tools.map((t) => t.command), ["./long-script.sh", "tail -f log"])
  assert.equal(tools.length, 2)
  // Each poll landed on its OWN owner: the script got "finished", the tail got "tailed".
  assert.match(tools[0].output ?? "", /finished/)
  assert.match(tools[1].output ?? "", /tailed/)
})

test("real cell/wait terminal envelopes retire their owning shell without requiring an exit code", () => {
  const lifecycle = (terminal: "completed" | "failed" | "terminated") => rollout([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: `launch-${terminal}`, name: "exec", input: `const running = tools.exec_command({cmd:"long-${terminal}",yield_time_ms:30000}); yield_control(); const r = await running; text(r.output);` } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: `launch-${terminal}`, output: "Script running with cell ID 39\nWall time 11.0 seconds\nOutput:\n" } },
    { type: "response_item", payload: { type: "function_call", call_id: `wait-${terminal}`, name: "wait", arguments: JSON.stringify({ cell_id: "39", yield_time_ms: 30000, max_tokens: 10000 }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: `wait-${terminal}`, output: `Script ${terminal}\nWall time 16.7 seconds\nOutput:\n${terminal}-output` } },
  ])
  const completed = parseCodexTranscript(lifecycle("completed"))[0].tools[0]
  assert.deepEqual(
    { status: completed.status, backgroundState: completed.backgroundState, output: completed.output },
    { status: "completed", backgroundState: "background", output: "completed-output" },
  )
  assert.equal(parseCodexTranscript(lifecycle("failed"))[0].tools[0].status, "failed")
  assert.equal(parseCodexTranscript(lifecycle("terminated"))[0].tools[0].status, "cancelled")
})

// ---- Codex's thinking becomes the card's caption ----
// codex's exec carries no `description` field the way Claude's Bash does, so a codex card could only be
// titled by its own flattened command (0 of 29104 cards across the corpus had a caption). But codex emits
// a reasoning step immediately before nearly every call, and that step's bold header is precisely the
// status line its TUI prints above the command.
test("a codex reasoning header captions the tool call it precedes, once, without swallowing the command", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "**Planning worktree inspection and commit**" }] } },
    { type: "response_item", payload: { type: "function_call", call_id: "a", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: "Chunk ID: z1\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nM f.ts\n" } },
    // No new thinking before this one — the caption is SPENT, so it must not repeat down the batch.
    { type: "response_item", payload: { type: "function_call", call_id: "b", name: "exec_command", arguments: JSON.stringify({ cmd: "git diff" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "b", output: "Chunk ID: z2\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\n" } },
  ])
  // The reasoning block is its own message ahead of the tools, so take the message that has them.
  const tools = parseCodexTranscript(raw).flatMap((m) => m.tools)
  assert.equal(tools[0].desc, "Planning worktree inspection and commit")
  assert.equal(tools[1].desc, undefined)
  // The caption is additive: the command it describes is still on the card.
  assert.equal(tools[0].command, "git status --short")
})

test("a codex reasoning step that is prose rather than a bold header captions nothing", () => {
  const raw = rollout([
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "I am weighing whether the fixture should stay on disk for manual QA." }] } },
    { type: "response_item", payload: { type: "function_call", call_id: "a", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: "Chunk ID: y1\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nf.ts\n" } },
  ])
  assert.equal(parseCodexTranscript(raw).flatMap((m) => m.tools)[0].desc, undefined)
})

// ---- Peer messaging says what it can, and says why it can't say the rest ----
test("codex peer messages render as message cards; an encrypted body explains itself instead of reading as a bug", () => {
  const encrypted = "gAAAAABqU-akIizxXc0EnAT4vtESZIFClmfVfTOMv8q1siCAOyuV-UeURhiWLfpZ7TXdJiEZAqnqUO_DLc5TO4PF"
  const raw = rollout([
    { type: "response_item", payload: { type: "function_call", call_id: "s", name: "send_message", arguments: JSON.stringify({ target: "bun_project_survey", message: encrypted }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "s", output: "" } },
    { type: "response_item", payload: { type: "function_call", call_id: "f", name: "followup_task", arguments: JSON.stringify({ target: "batch2_plan", message: encrypted }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "f", output: "" } },
    // An unencrypted body (older codex builds) must still render verbatim.
    { type: "response_item", payload: { type: "function_call", call_id: "p", name: "send_message", arguments: JSON.stringify({ target: "scout", message: "check the staging deploy too" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "p", output: "" } },
  ])
  const [sent, followed, plain] = parseCodexTranscript(raw)[0].tools
  assert.equal(sent.sendTo, "bun_project_survey")
  assert.equal(sent.sendSummary, "bun_project_survey")
  assert.match(sent.sendBody ?? "", /Codex encrypts inter-agent message bodies/)
  // Never leak the token, and never show the bare redaction marker as if it were the message.
  assert.doesNotMatch(JSON.stringify([sent, followed, plain]), /gAAAA|\[encrypted payload\]/)
  // A queued follow-up is not a mid-turn steer, so the card carries its own verb.
  assert.equal(followed.sendType, "codex_followup")
  assert.equal(followed.sendTo, "batch2_plan")
  assert.equal(sent.sendType, undefined)
  assert.equal(plain.sendBody, "check the staging deploy too")
})

test("a Codex child's drawer marks its original task and later follow-up at their exact arrival points", () => {
  const instruction = (type: "NEW_TASK" | "MESSAGE", timestamp: string, body = "") => ({
    timestamp,
    type: "response_item",
    payload: {
      type: "agent_message",
      author: "/root",
      recipient: "/root/mocha",
      content: [
        { type: "input_text", text: `Message Type: ${type}\nTask name: /root/mocha\nSender: /root\nPayload:\n${body}` },
        { type: "encrypted_content", data: "gAAAA-opaque" },
      ],
    },
  })
  const messages = parseCodexTranscript(rollout([
    instruction("NEW_TASK", "2026-09-05T12:15:18.000Z"),
    { timestamp: "2026-09-05T12:15:19.000Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Reading the first task." } },
    instruction("NEW_TASK", "2026-09-05T12:20:00.000Z"),
    { timestamp: "2026-09-05T12:20:01.000Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Reading the follow-up." } },
  ]))

  assert.deepEqual(messages.map((message) => message.text), [
    "Task instructions received. Codex encrypted the message body, so Frizz can't display it.",
    "Reading the first task.",
    "Follow-up instructions received. Codex encrypted the message body, so Frizz can't display it.",
    "Reading the follow-up.",
  ])
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"])
  assert.equal(messages[2].at, "2026-09-05T12:20:00.000Z")
})

// Codex names its tools in snake_case and ships no display name, so the generic branch used to title
// cards with the raw identifier — `navigate_page`, `evaluate_script`, and at worst the fully
// namespaced `mcp__chrome_devtools__resize_page` — sitting beside proper labels like "Bash".
test("codex tool cards are titled with human labels, including unknown and MCP-namespaced tools", () => {
  const call = (id: string, name: string) => [
    { type: "response_item", payload: { type: "function_call", call_id: id, name, arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: id, output: "ok" } },
  ]
  const raw = rollout([
    ...call("a", "navigate_page"),
    ...call("b", "take_snapshot"),
    ...call("c", "mcp__chrome_devtools__resize_page"),
    // Never enumerated anywhere — must still read as a label, not as code.
    ...call("d", "nextjs_index"),
    // Already a proper label: left exactly as codex named it.
    ...call("e", "SomeVendorTool"),
  ])
  assert.deepEqual(
    parseCodexTranscript(raw).flatMap((m) => m.tools).map((t) => t.name),
    ["Navigate", "Snapshot", "Resize", "Nextjs index", "SomeVendorTool"],
  )
})

// THE PAGE REACHES THE HUMAN'S LAST MESSAGE, not merely the last `user` record. Frizz writes as the
// user — a Goal delivery, the sign-off reminder, a watcher wake are all `user` records carrying
// `wake: true` — so stopping at one cuts the page in the middle of a stretch the human never saw, which
// is the opposite of what a queue card is for.
test("pageProjectedTranscript walks past frizz's own deliveries to the human's message", () => {
  const at = "2026-08-12T00:00:00.000Z"
  const msg = (role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) =>
    ({ sourceId: text, role, text, tools: [], parts: [], at, ...extra }) as never
  const messages = [
    msg("user", "human: do the thing"),
    msg("assistant", "starting"),
    msg("user", "goal bump", { wake: true }),
    msg("assistant", "still going"),
    msg("user", "sign-off reminder", { wake: true }),
    msg("assistant", "here is the handoff"),
  ]
  const page = pageProjectedTranscript(messages, messages.length)
  assert.equal(page.start, 0, "the page starts at the human's message, not at the nearest wake")
  assert.equal(page.reachedTurnBoundary, true)
  assert.deepEqual(page.messages.map((m) => m.text), [
    "human: do the thing",
    "starting",
    "goal bump",
    "still going",
    "sign-off reminder",
    "here is the handoff",
  ])
})

// ---- tool-call collapsing across a turn's reasoning steps ----
// Codex thinks immediately before nearly every tool call (~1:1 across the corpus), and a turn's
// reasoning steps COALESCE into one block positioned where the FIRST step appeared. Every later step
// therefore pushes nothing — it appends upstream — so closing the open assistant message on it split
// each batch into a column of "Ran 1 tool call" rows (maintainer 2026-09-04: "Tool call collapsing is
// also totally broken"). Measured on a real 17-child orchestration rollout: 104 calls in 84 runs, 73
// of them a single call.
function codexThinkThenRun(pairs: number): string {
  const out: string[] = [JSON.stringify({ timestamp: "2026-09-04T18:47:27.000Z", type: "event_msg", payload: { type: "task_started" } })]
  for (let i = 0; i < pairs; i++) {
    const at = `2026-09-04T18:47:${String(30 + i * 2).padStart(2, "0")}.000Z`
    out.push(JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: `**Step ${i}**` }] } }))
    out.push(JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: `c${i}`, input: JSON.stringify({ command: `echo ${i}` }) } }))
    out.push(JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "custom_tool_call_output", call_id: `c${i}`, output: `${i}` } }))
  }
  return out.join("\n") + "\n"
}

test("codex: a turn's tool calls collapse into ONE group even though a reasoning step precedes each", () => {
  const msgs = projectCodexTranscript(codexThinkThenRun(6))
  const reasoning = msgs.filter((m) => m.kind === "reasoning")
  assert.equal(reasoning.length, 1, "the turn's six steps coalesce into one train-of-thought block")
  assert.match(reasoning[0].text, /\*\*Step 0\*\*[\s\S]*\*\*Step 5\*\*/, "every step lands in that one block")

  const groups = msgs.flatMap((m) => m.parts.filter((p) => p.kind === "tools"))
  assert.equal(groups.length, 1, "all six calls collapse into a single card group")
  assert.equal(groups[0].kind === "tools" ? groups[0].tools.length : 0, 6)
  // …and the group still sits BELOW the reasoning block the turn opened with.
  assert.ok(msgs.indexOf(reasoning[0]) < msgs.findIndex((m) => m.parts.some((p) => p.kind === "tools")))
})
