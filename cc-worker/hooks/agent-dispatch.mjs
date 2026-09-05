#!/usr/bin/env node
// @ts-check
// PreToolUse hook on the `Agent` tool (frizz-worker). A worker MAY spin up its own helper
// sub-agents; this hook holds them to the same rules cc enforces for the orchestrator:
//   1) ENFORCE background dispatch — deny any Agent call lacking run_in_background:true (a
//      foreground agent blocks the worker's turn; a human interjection orphans it).
//   2) STRIP `name`/`team_name` — setting either strands a nested dispatch (its result routes
//      wrong and never returns cleanly), so scrub both silently.
//   3) AUTO-APPEND a short ORCHESTRATION EPILOGUE carrying only what a helper cannot discover on
//      its own: that its final message is the return value, that nothing can WAKE it so it must not
//      end a turn on a waiter, the `SendMessage({to: "main"})` upward channel, the own-file rule for
//      the scratch directory, no fan-out of its own unless asked, and how a helper it DID dispatch
//      is collected. It carries no handoff format and no build, test, git or process policy — the
//      maintainer had the handoff-format doctrine cut on 2026-08-26.
//
// WHY THE LIFECYCLE PARAGRAPH EXISTS (2026-09-05): a child cannot be re-invoked, and nothing told it
// so. Claude's own task-notification states the rule from the dispatcher's side — "a task-notification
// fires each time this agent stops with no live background children of its own" — which means a child
// that backgrounds a shell and ends its turn has RETURNED: the completion is delivered to the
// dispatcher, and the child is never resumed to read it. A Fable helper on nubjs/nub hit this four
// times in one effort, each time handing back the same sentence ("Three background jobs are
// outstanding … I am waiting for their completion notifications before writing"), and its entire
// 118-tool-call investigation lived only in those transient returns until the dispatcher captured them
// by hand. `DECISIONS.md` has claimed since the SubagentStop hooks were dropped that "the
// worker-facing half of the rest-guard's lesson (run long ops inline, don't rest on a waiter) is
// carried in the dispatch epilogue instead" — it was not; this paragraph is that lesson.
//
// The same paragraph CORRECTED the nested-collection sentence below, which had promised since
// 2026-07-31 that a helper's "completion is delivered to you automatically". Measured 2026-09-05: a
// child instructed to dispatch one helper and stop the instant the Agent tool returned came back
// `DISPATCHED: yes / SAW_HELPER_REPLY: no`, and was never resumed to read the reply. The promise was
// false in precisely the direction that strands a child — it is the sentence a helper reasons its way
// back to after being told not to wait — so it now says a helper cannot wake you either. The
// anti-polling rule it was written to carry is untouched; only its premise was.
//
// WHY NESTING IS DEFAULT-OFF (2026-08-04, maintainer's call): the epilogue used to speak about a
// helper's own helper only in the conditional ("if you dispatch a helper of your own…"), which reads
// as neutral permission, so a depth-1 child could decompose again purely because it could. A child is
// already one prong of a fan-out; another layer splits the context its dispatcher assembled and moves
// the real work further from the board. So the paragraph now LEADS with "do the work yourself unless
// your prompt says otherwise" and keeps the collection rules for the case where it does. This is a
// PROMPT-level default, not the hook-level depth-2 DENY rejected on 2026-07-31 as too blunt — an
// explicit instruction to fan out still dispatches, unmodified.
//
// WHY THE NESTED-DISPATCH PARAGRAPH EXISTS (2026-07-31): this hook fires at EVERY depth, but the
// frizz worker contract reaches only the ROOT worker — so its "keep fan-out shallow / a rested agent
// is not reliably re-woken by grandchildren" rule was delivered exclusively to the one agent that
// does not spawn grandchildren, and withheld from the depth-1 child that does. Into that silence a
// user-level CLAUDE.md ("the parent stays awake and polls the child's transcript") supplied a
// hand-rolled polling recipe, and it failed: the `.output` path is a SYMLINK, so `stat` without -L
// returns the LINK's size (= the length of its target path) and its frozen creation mtime, while
// the `"type":"result"` record is never reliably written. Both halves of the predicate
// false-negatived at once, a live 413KB helper read as "size=153 age=325s results=0", and the
// dispatcher discarded it and redid the work itself. This paragraph is the only place that reaches
// a nested dispatcher without depending on its parent remembering to restate the norm.
//
// GATE: inert unless FRIZZ_THREAD is set (not a frizz worker → allow every dispatch unmodified).
//
// DROPPED vs cc's agent-dispatch.mjs (see DECISIONS.md): the `.dispatch-count` bump (it only gates
// cc's SubagentStop rest-recorder, which cc-worker does not ship) and the THREAD:-ledger write +
// thread-existence DENY gate (that guards the orchestrator's "file the thread before dispatching"
// discipline; a worker owns exactly one already-existing thread and its helpers own no thread).
//
// FAIL OPEN: any parse error → allow unmodified. A broken dispatch hook must never halt work.
import { readFileSync } from 'node:fs';

const EPILOGUE = `

---
[ORCHESTRATION EPILOGUE — auto-appended by the frizz worker dispatch hook] You are a helper sub-agent for a frizz worker. Your final message is the handoff your dispatcher reads: what you did, what you verified, what remains.
NOTHING CAN WAKE YOU — ending your turn IS your return. A job you backgrounded (Bash \`run_in_background:true\` above all) reports to your DISPATCHER, never to you, so a turn that ends while one is outstanding hands back unfinished work and leaves its result somewhere you will never read. So never end a turn waiting for something to finish: run long commands in the FOREGROUND, and where one would outrun the foreground limit, make the command itself loop until its own terminal condition rather than backgrounding it. If you did background something, collect it in the SAME turn. And if your dispatcher named a scratch directory, write anything you would not want to lose into your own file there AS YOU GO — a turn that ends early takes with it everything you had neither written down nor said.
If the worker names its scratch directory: Write your OWN file there — never edit or delete a file another agent wrote. That file is Frizz coordination state, not a project deliverable or source edit, so it stays allowed under limits such as "write only <path>" or "do not modify the repo"; never classify it as unauthorized or roll it back. Every other file is governed by your delegated authority; its location alone neither permits nor forbids editing. Do not edit other \`.frizz/\` state unless your prompt asks.
Upward channel: \`SendMessage({to: "main", summary: "<5-10 words>", message: "…"})\` reaches your dispatcher while you work (load it first with ToolSearch \`select:SendMessage\` if it is deferred). Use it only when the dispatcher acting before you finish would change the outcome — a blocker, a milestone another task needs, instructions that should change — not for progress updates.
Do the work yourself: do NOT dispatch sub-agents of your own unless your dispatch prompt explicitly tells you to. You are already one prong of someone else's fan-out; a slice that feels large is still yours to work through in your own turn.
If your prompt DOES ask you to dispatch a helper, the rule above still binds — a helper cannot wake you either: a dispatcher that stops is never resumed to read the reply. So collect it before your turn ends, or do not dispatch it. Never hand-roll a wait loop over a helper's transcript or \`.output\` path: that path is a SYMLINK (\`stat\` without \`-L\` reports the link's own ~150-byte size and frozen mtime) and the \`"type":"result"\` record is not reliably written, so a helper working hard reads as tiny, stale and dead, and you will discard live work and redo it. Judge a helper only by what it actually returns to you, and give it a \`description\` naming its narrower slice.`;

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

try {
  // WORKER GATE — inert outside a frizz worker session.
  if (!(process.env.FRIZZ_THREAD ?? '').trim()) emit({});

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const ti = input.tool_input ?? {};

  if (ti.run_in_background !== true) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'frizz worker (hook-enforced): Agent sub-agents MUST be dispatched with run_in_background:true — never foreground/blocking. A foreground agent blocks the worker turn and a human interjection orphans its work. Re-send this Agent call with run_in_background:true.',
      },
    });
  }

  // Strip name/team_name (they strand nested dispatches), then append the epilogue once.
  const { name: _droppedName, team_name: _droppedTeam, ...tiStripped } = ti;
  // Idempotence is "this prompt ALREADY ENDS WITH the epilogue", not "this prompt mentions the
  // marker anywhere". A substring test silently ate the epilogue for any prompt that merely QUOTED
  // the marker — e.g. a worker asking a helper to report whether the epilogue reached it, which is
  // exactly how this was caught. endsWith still catches a genuine double-fire (the only real case).
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  const updatedInput = prompt.endsWith(EPILOGUE)
    ? tiStripped
    : { ...tiStripped, prompt: prompt + EPILOGUE };

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  });
} catch {
  emit({}); // fail open — allow unmodified
}
