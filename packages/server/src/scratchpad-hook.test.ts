import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { codexScratchpadHookConfig } from "./dispatch.ts"

// ---- scratch-directory hook (cc-worker/hooks/scratchpad.mjs) ----
// Keeps a worker aware of its per-thread scratch DIRECTORY and re-orients it there when the context is
// lost: it names what is in the directory after a compaction/resume, tells the summarizer those files
// exist, and nudges when the context has moved on since the last write. These tests EXECUTE the real
// hook the way Claude Code does — argv flags, a JSON event on stdin, output on stdout — rather than
// asserting on its source, because the whole value of the hook is its wire behavior. Verified live
// against cli 2.1.220 as well: a real session quoted injected text with zero tool calls,
// `PreCompact:manual` logged status 0, and PostToolUse additionalContext reached the model mid-turn.
//
// IT POINTS, IT NO LONGER INJECTS. Until 2026-08-06 frizz provisioned one canonical `scratch.md` and
// this hook spliced its head into the emptied window. The maintainer replaced that with a free-form
// directory plus the recurring prompt's post_compaction trigger, so the guaranteed channel is now
// something the WORKER arms and the OPERATOR can see. What the hook still owes is the listing — and
// the test below pins that it is a listing and never the content.

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../cc-worker/hooks/scratchpad.mjs")
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "scratchpad-hook-"))
  mkdirSync(join(dir, ".frizz", "threads", SID), { recursive: true })
  return dir
}

function scratchPath(dir: string, name = "notes.md"): string {
  return join(dir, ".frizz", "threads", SID, name)
}

/** Write one file into the thread's scratch directory. The worker chooses these names; nothing in
 *  frizz reserves one, so the tests use several to prove the hook does not privilege any. */
function writeScratch(dir: string, body: string, name = "notes.md"): void {
  writeFileSync(scratchPath(dir, name), body)
}

// A transcript whose newest usage record reports `tokens` of context fill — the same shape Claude
// Code writes (`input + cache_creation + cache_read`), which is what the nudge reads.
function writeTranscript(dir: string, tokens: number): string {
  const path = join(dir, "transcript.jsonl")
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1002 }
  writeFileSync(
    path,
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) +
      "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage } }) +
      "\n"
  )
  return path
}

function runHook(
  dir: string,
  args: string[],
  event: Record<string, unknown>,
  env: Record<string, string> = {}
): string {
  return execFileSync("node", [HOOK, ...args], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      FRIZZ_THREAD: "",
      FRIZZ_SCRATCHPAD_HOOK: "",
      ...env,
    },
  })
}

function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string
}

test("a fresh startup offers the directory and names the goal capability without pushing it", () => {
  const dir = newProject()
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }))
  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, /nothing in it is read automatically/)
  // The capability stays NAMED — the worker can arm it — but it is offered, never prescribed
  // (maintainer 2026-08-28: stop pushing the notes-plus-arming arrangement).
  assert.match(ctx, /`frizzctl goal start --post-compaction`/)
  assert.match(ctx, /Use it if you want it/)
  assert.doesNotMatch(ctx, /then arm|write the doc/, "the arrangement is offered, never pushed")
})

test("after a compaction the hook NAMES the scratch files and never injects their content", () => {
  const dir = newProject()
  // Content that would be unmistakable if it leaked into the injection.
  writeScratch(dir, "UNMISTAKABLE-BODY-TEXT\n".repeat(40), "plan.md")
  writeScratch(dir, "reviewer findings", "reviewer.md")
  // frizz's own per-thread bookkeeping lives in the same directory and is NOT the worker's notes.
  writeFileSync(scratchPath(dir, ".scratchpad-state.json"), "{}")
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))

  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, new RegExp(`\\.frizz/threads/${SID}/plan\\.md`))
  assert.match(ctx, new RegExp(`\\.frizz/threads/${SID}/reviewer\\.md`))
  // THE LOAD-BEARING ASSERTION. Naming is the accepted cost of dropping the canonical pad; quietly
  // re-growing this back into a content injection would restore exactly what was removed.
  assert.doesNotMatch(ctx, /UNMISTAKABLE-BODY-TEXT/, "a listing, never the content")
  assert.doesNotMatch(ctx, /scratchpad-state/, "frizz's own bookkeeping is not the worker's notes")
  // And it still names the post-compaction goal as an available capability.
  assert.match(ctx, /`frizzctl goal start --post-compaction`/)
})

test("a fresh startup does not pay for the listing — only the context-losing sources get it", () => {
  const dir = newProject()
  writeScratch(dir, "real notes here\n", "plan.md")
  const startup = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }))
  assert.doesNotMatch(startup, /plan\.md/, "a brand-new session has lost nothing to re-orient on")
  for (const source of ["compact", "resume", "clear"]) {
    const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source }))
    assert.match(ctx, /plan\.md/, `${source} has lost context and must be told what it left itself`)
  }
})

// Claude Code opens EVERY compaction summary with the fixed sentence "This session is being continued
// from a previous conversation that ran out of context." It is about the conversation just summarized,
// but it arrives when the window is emptiest and workers read it as a report on themselves and wind
// down — nub session 5258ebe4 took its auto-compaction at transcript line 20239 and then declared
// "I'm out of context" on 13 consecutive turns at fills of 176k-244k. This hook is the only frizz text
// that lands in that exact window, so it is where the preamble gets answered. Pinned on BOTH pad
// states, because a compacted worker with an empty pad is the one least able to argue with it.
test("a compaction re-ground contradicts the summary's 'ran out of context' preamble", () => {
  // Pinned on BOTH directory states — a compacted worker that left itself nothing is the one least
  // able to argue with the preamble.
  for (const write of [true, false]) {
    const dir = newProject()
    if (write) writeScratch(dir, "the approach and why\n", "plan.md")
    const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
    assert.match(ctx, /ran out of context/, "the preamble is quoted so the worker knows what is being corrected")
    assert.match(ctx, /this window is close to EMPTY again/)
    assert.match(ctx, /compact and continue as many times as the effort needs/)
    assert.match(ctx, /not a reason to wind down, hand off, or leave the next step to a fresh session/)
  }
})

test("only a COMPACT start answers the preamble — a resume never saw one", () => {
  const dir = newProject()
  writeScratch(dir, "the approach and why\n", "plan.md")
  for (const source of ["resume", "clear"]) {
    const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source }))
    assert.match(ctx, /⟦scratch directory⟧/, `${source} still re-orients`)
    assert.doesNotMatch(ctx, /ran out of context/, `${source} gets no compaction summary, so there is nothing to correct`)
  }
})

test("precompact emits PLAIN stdout (never JSON) so it reaches the summarizer's instructions", () => {
  const dir = newProject()
  writeScratch(dir, "the approach and why\n", "plan.md")
  const out = runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" })
  assert.match(out, /plan\.md/, "the summarizer is told the file exists so it can carry the path forward")
  assert.doesNotMatch(out, /the approach and why/, "the summarizer gets the path, not the prose")
  // Emitting JSON here would hand the summarizer a blob of JSON as its literal instructions.
  assert.throws(() => JSON.parse(out), "precompact output must not be JSON")
  assert.doesNotMatch(out, /hookSpecificOutput/)
})

test("precompact is silent when the worker wrote nothing", () => {
  const dir = newProject()
  assert.equal(runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" }), "")
})

test("a large directory is summarized rather than listed line by line", () => {
  const dir = newProject()
  for (let i = 0; i < 12; i++) writeScratch(dir, "x", `note-${i}.md`)
  const ctx = additionalContext(
    runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }, { FRIZZ_SCRATCH_MAX_LISTED: "5" })
  )
  assert.match(ctx, /…and 7 more/, "a worker with many files needs the count, not every line")
  assert.equal((ctx.match(/note-\d+\.md/g) ?? []).length, 5)
})

test("every silence gate holds: project registration under frizz, sub-agents, and the kill switch", () => {
  const dir = newProject()
  writeScratch(dir, "should never appear\n", "plan.md")
  const evt = { session_id: SID, source: "compact" }
  // The repo-local `.claude/settings.json` copy defers to the plugin one inside a frizz worker.
  assert.equal(runHook(dir, ["--mode=session-start", "--via=project"], evt, { FRIZZ_THREAD: "t" }), "")
  assert.notEqual(runHook(dir, ["--mode=session-start", "--via=project"], evt), "")
  // Sub-agents do not get root re-ground/nudge injections; their dedicated start epilogue owns the
  // collaborative editing contract instead.
  assert.equal(runHook(dir, ["--mode=session-start"], { ...evt, agent_id: "sub-1" }), "")
  assert.equal(runHook(dir, ["--mode=session-start"], evt, { FRIZZ_SCRATCHPAD_HOOK: "off" }), "")
  // …but a non-off value never disables it: absence means ON now.
  assert.notEqual(runHook(dir, ["--mode=session-start"], evt, { FRIZZ_SCRATCHPAD_HOOK: "maybe" }), "")
  // With no session id there is no key, and an unkeyed pad would bleed across sessions.
  assert.equal(runHook(dir, ["--mode=session-start"], { source: "compact" }, { CLAUDE_CODE_SESSION_ID: "" }), "")
})

test("the codex child epilogue gives a child its OWN file instead of a document to merge into", () => {
  const dir = newProject()
  const out = JSON.parse(
    runHook(dir, [`--session=${SID}`, "--mode=subagent-start"], {
      session_id: "codex-rollout-id",
      agent_id: "/root/reviewer",
      hook_event_name: "SubagentStart",
    })
  )
  assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart")
  const ctx = out.hookSpecificOutput.additionalContext as string
  assert.match(ctx, new RegExp(`\\.frizz/threads/${SID}/`))
  assert.match(ctx, /create your own file in it/)
  // The failure this replaced: an undifferentiated "keep the doc current" mandate once made a native
  // child replace a shared document with its task notes, then delete the replacement as a rollback.
  // One file per writer removes the hazard instead of policing it.
  assert.match(ctx, /never edit, replace or delete a file another agent wrote/)
  assert.match(ctx, /nothing to merge and nothing to clobber/)
  assert.doesNotMatch(ctx, /merge your own scoped progress/, "the merge mandate is gone, not reworded")
  // The delegated-authority carve-out survives: a task that says "write only <path>" must not be read
  // as forbidding the child's own coordination file.
  assert.match(ctx, /Frizz coordination state, not a project deliverable or source edit/)
  assert.match(ctx, /“write only <path>”/)
  assert.match(ctx, /location alone neither permits nor forbids editing/)
})

// SubagentStart is the only structural seam that reaches a native codex child, so it carries the
// codex half of the default-off nesting rule — agent-dispatch.mjs's epilogue is the Claude half.
test("the codex child epilogue tells the child not to spawn agents of its own unasked", () => {
  const dir = newProject()
  const out = JSON.parse(
    runHook(dir, [`--session=${SID}`, "--mode=subagent-start"], {
      session_id: "codex-rollout-id",
      agent_id: "/root/reviewer",
      hook_event_name: "SubagentStart",
    })
  )
  const ctx = out.hookSpecificOutput.additionalContext as string
  assert.match(ctx, /do not spawn agents of your own \(`spawn_agent`\) unless the task you were given explicitly tells you to/)
  assert.match(ctx, /already one prong of the root worker’s fan-out/)
})

test("the nudge tracks context GROWTH, not an absolute threshold or wall clock", () => {
  const dir = newProject()
  const stale = { FRIZZ_SCRATCHPAD_STALE_TOKENS: "60000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  assert.equal(nudge(20_000), "", "below the threshold the hook must say nothing")

  // An EMPTY directory measures growth from ZERO — the whole session is unrecorded.
  const empty = additionalContext(nudge(70_000))
  assert.match(empty, /⟦scratch directory empty⟧/)
  assert.match(empty, /~70k tokens deep/)

  assert.equal(nudge(75_000), "", "a second nudge must not follow immediately")

  writeScratch(dir, "now written with real content\n", "plan.md")
  assert.equal(nudge(76_000), "", "a fresh write silences the nudge")
  assert.equal(nudge(120_000), "", "44k of growth is still under the interval")

  const restale = additionalContext(nudge(140_000))
  assert.match(restale, /⟦scratch notes stale⟧/)
  assert.match(restale, /grown ~64k tokens/)
})

test("the mid-turn channel reports itself as PostToolUse so the harness accepts the injection", () => {
  const dir = newProject()
  const out = runHook(
    dir,
    ["--mode=nudge", "--event=PostToolUse"],
    { session_id: SID, transcript_path: writeTranscript(dir, 90_000) },
    { FRIZZ_SCRATCHPAD_STALE_TOKENS: "60000" }
  )
  // A frizz worker runs enormous autonomous turns; a turn-boundary-only nudge can miss a whole
  // session's work. The event name must match the firing hook or the payload is rejected.
  assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, "PostToolUse")
  assert.match(additionalContext(out), /⟦scratch directory empty⟧/)
})

test("both nudge channels share one interval, so mid-turn firing does not multiply reminders", () => {
  const dir = newProject()
  const stale = { FRIZZ_SCRATCHPAD_STALE_TOKENS: "60000" }
  const t = (tokens: number) => ({ session_id: SID, transcript_path: writeTranscript(dir, tokens) })

  assert.notEqual(runHook(dir, ["--mode=nudge", "--event=PostToolUse"], t(70_000), stale), "", "first fires")
  // The turn-boundary channel must respect the budget the mid-turn channel just spent.
  assert.equal(runHook(dir, ["--mode=nudge"], t(75_000), stale), "", "shared state suppresses the sibling")
  assert.equal(runHook(dir, ["--mode=nudge", "--event=PostToolUse"], t(80_000), stale), "")
})

test("the nudge rebases when ANY file in the directory is touched, by agent or human", () => {
  const dir = newProject()
  const stale = { FRIZZ_SCRATCHPAD_STALE_TOKENS: "10000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  writeScratch(dir, "v1 with content\n", "plan.md")
  nudge(20_000)
  assert.notEqual(nudge(40_000), "", "stale after 20k of growth")

  // A DIFFERENT file — the clock is the newest write across the whole directory, not one path's.
  writeScratch(dir, "a sub-agent's findings\n", "reviewer.md")
  const future = new Date(Date.now() + 1000)
  utimesSync(scratchPath(dir, "reviewer.md"), future, future)
  assert.equal(nudge(45_000), "", "any write anywhere in the directory rebases the baseline")
})

test("the nudge is silent when the transcript carries no readable usage", () => {
  const dir = newProject()
  const path = join(dir, "empty.jsonl")
  writeFileSync(path, "not json\n{}\n")
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: path }), "")
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID }), "")
})

test("hooks.json wires every channel, and no stale carryover registration survives", () => {
  const raw = readFileSync(join(here, "../../../cc-worker/hooks/hooks.json"), "utf8")
  assert.doesNotMatch(raw, /carryover/, "the separate carryover doc was collapsed into the scratchpad")
  const cfg = JSON.parse(raw) as Record<string, Record<string, { matcher?: string; hooks: { command: string }[] }[]>>
  const commandsFor = (event: string) =>
    (cfg.hooks[event] ?? []).flatMap((entry) => entry.hooks.map((h) => h.command))

  for (const matcher of ["startup", "resume", "clear", "compact"]) {
    const entry = (cfg.hooks.SessionStart ?? []).find((e) => e.matcher === matcher)
    assert.ok(entry, `SessionStart must register a ${matcher} matcher`)
    assert.ok(entry.hooks.some((h) => h.command.includes("scratchpad.mjs") && h.command.includes("--mode=session-start")))
  }
  for (const trigger of ["auto", "manual"]) {
    const entry = (cfg.hooks.PreCompact ?? []).find((e) => e.matcher === trigger)
    assert.ok(entry, `PreCompact must register a ${trigger} matcher`)
    assert.ok(entry.hooks.some((h) => h.command.includes("scratchpad.mjs") && h.command.includes("--mode=precompact")))
  }
  assert.ok(commandsFor("UserPromptSubmit").some((c) => c.includes("scratchpad.mjs") && c.includes("--mode=nudge")))
  // The mid-turn channel must be UNMATCHED (every tool), not scoped to one tool name.
  const midTurn = (cfg.hooks.PostToolUse ?? []).find((e) =>
    e.hooks.some((h) => h.command.includes("scratchpad.mjs"))
  )
  assert.ok(midTurn, "PostToolUse must carry the mid-turn nudge")
  assert.equal(midTurn.matcher, undefined, "the mid-turn nudge must fire after every tool call")
  assert.ok(midTurn.hooks.some((h) => h.command.includes("--event=PostToolUse")))
})

// ---- backend parity: the CODEX delivery path ----
// Codex cannot be gated the way Claude is. Measured against codex-cli 0.144.6:
//   • `codex exec` runs NO hooks from any discovery path — only the app-server does, and only when
//     the hooks arrive as per-conversation config overrides (with bypass_hook_trust).
//   • The app-server daemon is SHARED per project, so its environment cannot carry a per-conversation
//     decision — hence `--enabled` rather than the env var.
//   • Codex reports its OWN rollout session id to the hook, not frizz's thread id — hence `--session`.
// Verified live: SessionStart / UserPromptSubmit / Stop all fired through CodexAppServerBridge with
// the real scratchpad.mjs wired exactly as codexScratchpadHookConfig wires it.

test("re-orienting is UNCONDITIONAL — no setting, no flag, no env var required", () => {
  const dir = newProject()
  writeScratch(dir, "canonical content\n", "plan.md")
  // No opt-in of any kind. An earlier revision gated this behind a default-OFF setting, which meant
  // the DEFAULT worker recovered nothing after a compaction — the exact failure it exists to prevent.
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, /plan\.md/)
  // The only escape hatch is an explicit env off — a one-off, not a project posture.
  assert.equal(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }, { FRIZZ_SCRATCHPAD_HOOK: "off" }), "")
})

test("an EMPTY directory still re-orients after compaction, and says so plainly", () => {
  const dir = newProject()
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  // "You lost your context and left yourself nothing" is the most urgent thing the next turn can hear —
  // staying silent here was the old behavior and it left the worker with nothing at all.
  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, /is EMPTY — you left yourself nothing to recover from/)
  assert.match(ctx, /Do not search other `\.frizz\/threads\/\*\/` directories/)
  assert.match(ctx, /retained compaction summary/)
  // …and it says how to not be here again.
  assert.match(ctx, /`frizzctl goal start --post-compaction`/)
})

test("--session overrides the reported id, so a codex worker finds FRIZZ's directory not its own", () => {
  const dir = newProject()
  writeScratch(dir, "frizz thread content\n", "frizz-thread-file.md")
  // Exactly what codex sends: its own rollout session id, and a transcript under ~/.codex/sessions.
  const codexEvent = {
    session_id: "019fb427-93aa-7ab0-91af-436173f99bc4",
    source: "compact",
    hook_event_name: "SessionStart",
    transcript_path: "/Users/x/.codex/sessions/2026/07/30/rollout-019fb427.jsonl",
  }
  // Without --session the hook addresses codex's id — a directory that does not exist — so it can
  // only report an empty one.
  const derived = additionalContext(runHook(dir, ["--mode=session-start"], codexEvent))
  assert.doesNotMatch(derived, /frizz-thread-file\.md/)
  // With it, the real directory is found.
  const explicit = additionalContext(
    runHook(dir, [`--session=${SID}`, "--mode=session-start"], codexEvent)
  )
  assert.match(explicit, /frizz-thread-file\.md/)
  assert.match(explicit, new RegExp(`\\.frizz/threads/${SID}/`))
})

// NO FILENAME IS RESERVED, and nothing in a scratch file is parsed. `scratch.md` used to be the one
// canonical name with a `stop_hook:` frontmatter key on top of it; both are gone (2026-08-06). A file
// still called scratch.md is now just another file the worker happened to name that way.
test("no filename is privileged — scratch.md is listed like any other file, and nothing is parsed", () => {
  const dir = newProject()
  writeScratch(dir, "---\nstop_hook: Re-check the operation I still own.\n---\n\nstate\n", "scratch.md")
  writeScratch(dir, "other", "zzz-other.md")
  const out = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  assert.match(out, /scratch\.md/)
  assert.match(out, /zzz-other\.md/)
  assert.doesNotMatch(out, /stop_hook/, "frontmatter is not read, because no content is read")
})

test("a codex rollout carries no readable claude usage, so the nudge degrades to silence", () => {
  const dir = newProject()
  writeScratch(dir, "content\n", "plan.md")
  const rollout = join(dir, "rollout.jsonl")
  // The real codex rollout shape — event_msg/payload, not claude's message.usage.
  writeFileSync(
    rollout,
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }) + "\n"
  )
  // Silence, never a crash and never a bogus token count: the codex nudge channel simply does not
  // fire until a rollout-aware token parser exists. The codex INJECTION channel is unaffected.
  assert.equal(runHook(dir, [`--session=${SID}`, "--mode=nudge"], { session_id: SID, transcript_path: rollout }), "")
})

// ---- codex delivery is unconditional too ----

test("the codex hook config is built unconditionally, and carries what codex requires", () => {
  // No plugin path or no session id must still produce nothing rather than a broken command.
  assert.deepEqual(codexScratchpadHookConfig(undefined, "sid-1"), {})
  assert.deepEqual(codexScratchpadHookConfig("/p/scratchpad.mjs", ""), {})

  const cfg = codexScratchpadHookConfig("/p/scratchpad.mjs", "sid-1") as {
    bypass_hook_trust?: boolean
    hooks?: Record<string, { hooks: { command: string }[] }[]>
  }
  // Codex silently SKIPS untrusted hook definitions, so without this the config is delivered and ignored.
  assert.equal(cfg.bypass_hook_trust, true)
  // Codex exposes no PreCompact/PostCompact wire type, so summarizer steering stays Claude-only.
  // SubagentStart carries the own-file epilogue; the rest orient or nudge.
  assert.deepEqual(Object.keys(cfg.hooks ?? {}).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"])
  for (const [event, entries] of Object.entries(cfg.hooks ?? {})) {
    const cmd = entries[0].hooks[0].command
    if (event === "PreToolUse") {
      assert.match(cmd, /bash-background\.mjs/)
      assert.match(cmd, /--frizz-thread/)
    } else {
      assert.match(cmd, /--session="sid-1"/, "frizz's thread id must override codex's own reported session id")
      assert.doesNotMatch(cmd, /--enabled/, "there is no opt-in flag any more")
      assert.match(cmd, /scratchpad\.mjs/)
    }
  }
  assert.match(cfg.hooks?.SubagentStart?.[0]?.hooks[0]?.command ?? "", /--mode=subagent-start/)
  assert.match(cfg.hooks?.SessionStart?.[0]?.hooks[0]?.command ?? "", /--mode=session-start --resume-keeps-context$/)
})

// A Codex thread is resumed from its rollout with its whole conversation, and Frizz resumes one
// routinely: its first message after every Frizz restart, and again when a newer Frizz hands it new
// hooks. Those hooks ride every resume since 2026-10-11, so SessionStart(resume) now FIRES there — and
// "Context was just lost" would be false every time. The Codex registration carries the flag; Claude's
// does not, because a Claude resume is a cold start of the process.
test("a Codex resume is silent, because it lost nothing — and only a resume is", () => {
  const dir = newProject()
  writeScratch(dir, "the approach and why\n", "plan.md")
  const codex = ["--mode=session-start", "--resume-keeps-context"]
  assert.equal(runHook(dir, codex, { session_id: SID, source: "resume" }), "")
  // A compaction did lose the conversation, on Codex as anywhere; a fresh start is still oriented.
  assert.match(additionalContext(runHook(dir, codex, { session_id: SID, source: "compact" })), /Context was just compacted/)
  assert.match(additionalContext(runHook(dir, codex, { session_id: SID, source: "startup" })), /⟦scratch directory⟧/)
  // Without the flag — Claude's registration — a resume keeps its re-orientation.
  assert.match(additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "resume" })), /Context was just lost/)
})

// Claude Code fixes CLAUDE_PROJECT_DIR when a session starts, so after Frizz renames the project's
// folder a worker's hooks still name the old path. On 2026-11-04 the next PostToolUse `mkdir -p`'d
// that path back into being as an empty stub, and Claude Code then moved the session's working
// directory into it. A folder that has gone is left gone, by this hook and by session-seed (which
// writes its sentinel under the same variable on every SessionStart, compaction included).
test("a project folder that has been renamed away is never recreated by a hook", () => {
  const parent = mkdtempSync(join(tmpdir(), "scratchpad-hook-renamed-"))
  const gone = join(parent, "renamed-away")
  const transcript = writeTranscript(parent, 120_000)
  runHook(gone, ["--mode=nudge", "--event=PostToolUse"], { session_id: SID, transcript_path: transcript })
  runHook(gone, ["--mode=nudge"], { session_id: SID, transcript_path: transcript })
  runHook(gone, ["--mode=session-start"], { session_id: SID, source: "compact" })
  runHook(gone, ["--mode=precompact"], { session_id: SID, trigger: "auto" })
  execFileSync("node", [join(here, "../../../cc-worker/hooks/session-seed.mjs")], {
    input: JSON.stringify({ session_id: SID, source: "compact" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: gone, FRIZZ_THREAD: "some-thread" },
  })
  assert.equal(existsSync(gone), false, "no hook made a stub of the old folder")
  // The same hooks still write into a folder that is there — the guard is about absence, nothing else.
  const dir = newProject()
  runHook(dir, ["--mode=nudge", "--event=PostToolUse"], { session_id: SID, transcript_path: transcript })
  assert.equal(existsSync(join(dir, ".frizz", "threads", SID, ".scratchpad-state.json")), true)
})
