import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../cc-worker/hooks/agent-dispatch.mjs")

function decision(toolInput: Record<string, unknown>, worker = true): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: worker ? "thread-under-test" : "" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

function output(toolInput: Record<string, unknown>, worker = true): Record<string, any> {
  return decision(toolInput, worker).hookSpecificOutput ?? {}
}

const dispatch = { prompt: "Survey the dev server readouts.", run_in_background: true }

test("Agent dispatch hook denies foreground sub-agents", () => {
  for (const input of [
    { prompt: "p" },
    { prompt: "p", run_in_background: false },
    { prompt: "p", run_in_background: "true" },
  ]) {
    const denied = output(input)
    assert.equal(denied.permissionDecision, "deny", JSON.stringify(input))
    assert.match(denied.permissionDecisionReason, /run_in_background:true/)
  }
})

test("Agent dispatch hook strips name and team_name, which strand a nested dispatch", () => {
  const updated = output({ ...dispatch, name: "researcher", team_name: "research" }).updatedInput
  assert.equal(updated.name, undefined)
  assert.equal(updated.team_name, undefined)
  assert.equal(updated.run_in_background, true)
})

test("Agent dispatch hook appends the orchestration epilogue exactly once", () => {
  const once = output(dispatch).updatedInput.prompt as string
  assert.ok(once.startsWith(dispatch.prompt))
  assert.equal(once.match(/ORCHESTRATION EPILOGUE/g)?.length, 1)
  // Idempotence is "already ENDS WITH the epilogue" — a prompt that merely QUOTES the marker
  // (a worker asking a helper whether the epilogue arrived) must still get its own copy.
  assert.equal(output({ ...dispatch, prompt: once }).updatedInput.prompt, once)
  const quoting = output({ ...dispatch, prompt: "Report whether the ORCHESTRATION EPILOGUE reached you." })
  assert.equal((quoting.updatedInput.prompt as string).match(/ORCHESTRATION EPILOGUE/g)?.length, 2)
})

// The regression this hook's nested-dispatch paragraph exists for: a depth-1 helper backgrounded its
// own helper, hand-rolled a `stat`-based wait over the `.output` path — which is a SYMLINK, so the
// size/mtime it read were the LINK's, frozen forever — declared a live 413KB agent dead, and redid
// its work. The frizz worker contract never reaches a depth-1 helper, so this epilogue is the only
// place that can tell it how to collect a helper of its own.
// Nesting is DEFAULT-OFF. The conditional phrasing this replaced ("if you dispatch a helper of your
// own…") read as neutral permission, so a helper could fan out again purely because it could.
test("Agent dispatch hook tells every helper not to fan out unless its prompt asked", () => {
  const prompt = output(dispatch).updatedInput.prompt as string
  assert.match(prompt, /do NOT dispatch sub-agents of your own unless your dispatch prompt explicitly tells you to/)
  assert.match(prompt, /already one prong of someone else's fan-out/)
  assert.match(prompt, /still yours to work through in your own turn/)
})

test("Agent dispatch hook tells every helper how to collect a helper of its own", () => {
  const prompt = output(dispatch).updatedInput.prompt as string
  assert.match(prompt, /If your prompt DOES ask you to dispatch a helper/)
  // MEASURED 2026-09-05: a helper does not wake its dispatcher either. A child told to dispatch one
  // and stop immediately reported `SAW_HELPER_REPLY: no` and was never resumed — so the epilogue's
  // old promise that "its completion is delivered to you automatically" was false in exactly the
  // direction that strands a child, and is the sentence a stranded helper reasons its way back to.
  assert.match(prompt, /a helper cannot wake you either/)
  assert.match(prompt, /collect it before your turn ends, or do not dispatch it/)
  assert.doesNotMatch(prompt, /delivered to you automatically/, "a helper's completion does NOT reach a stopped dispatcher")
  assert.match(prompt, /Never hand-roll a wait loop/)
  assert.match(prompt, /SYMLINK/)
  assert.match(prompt, /"type":"result". record is not reliably written/)
  assert.match(prompt, /discard live work and redo it/)
  assert.match(prompt, /description. naming its narrower slice/)
  // The anti-polling rule survives the correction: judge a helper by what it returns, never by
  // stat-ing its transcript. What changed is only the false premise that it returns to a stopped one.
  assert.match(prompt, /Judge a helper only by what it actually returns to you/)
})

test("Agent dispatch hook keeps the handoff, scratch-file and upward-channel coordination", () => {
  const prompt = output(dispatch).updatedInput.prompt as string
  assert.match(prompt, /Your final message is the handoff/)
  // One file per writer replaced the shared-document merge contract (2026-08-06): the hazard it
  // policed — a child rewriting or rolling back a document it did not create — cannot arise now.
  assert.match(prompt, /Write your OWN file there/)
  assert.match(prompt, /never edit or delete a file another agent wrote/)
  assert.doesNotMatch(prompt, /merge your own scoped progress/, "the merge mandate is gone, not reworded")
  // The delegated-authority carve-out lives HERE now, not in the worker contract: a child told
  // "write only <path>" must not read that as forbidding its own coordination file.
  assert.match(prompt, /Frizz coordination state, not a project deliverable or source edit/)
  assert.match(prompt, /write only <path>/)
  assert.match(prompt, /location alone neither permits nor forbids editing/)
  assert.match(prompt, /SendMessage\(\{to: "main"/)
})

// A child cannot be re-invoked: Claude notifies the DISPATCHER when a helper "stops with no live
// background children of its own", and never resumes the helper to read that result. A Fable helper
// on nubjs/nub stranded itself four times in one effort on exactly this, returning "I am waiting for
// their completion notifications before writing" while its whole investigation sat unwritten. Nothing
// in the epilogue had ever said so, though DECISIONS.md claimed it did.
test("Agent dispatch hook tells every helper that nothing can wake it", () => {
  const prompt = output(dispatch).updatedInput.prompt as string
  assert.match(prompt, /NOTHING CAN WAKE YOU/)
  assert.match(prompt, /ending your turn IS your return/)
  assert.match(prompt, /reports to your DISPATCHER, never to you/)
  assert.match(prompt, /never end a turn waiting for something to finish/)
  assert.match(prompt, /collect it in the SAME turn/)
  // The second half of the same failure: findings that exist only in a return message die with it.
  assert.match(prompt, /AS YOU GO/)
})

test("Agent dispatch hook is inert outside a frizz worker session", () => {
  assert.deepEqual(decision(dispatch, false), {})
  assert.deepEqual(decision({ prompt: "p" }, false), {})
})

test("Agent dispatch hook fails open on unparseable input", () => {
  const result = spawnSync(process.execPath, [hook], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: "thread-under-test" },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout || "{}"), {})
})
