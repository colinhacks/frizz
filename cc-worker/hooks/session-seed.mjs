#!/usr/bin/env node
// @ts-check
// SessionStart hook (frizz-worker) — SEEDS a frizz WORKER session's context. Run directly with
// node (zero deps, max Node compat), mirroring cc's hook idiom.
//
// A frizz worker is a top-level interactive `claude` the UI spawns per effort; the slug arrives in
// env FRIZZ_THREAD (and a `THREAD:` line in the first prompt). There are NO thread files, no
// frontmatter, no status field — a worker SIGNALS through its final message (fences), and anything that
// must outlive its context window is an arrangement it makes for itself. This hook injects, on every
// session start (startup/resume/clear/compact):
//   1. `core` — a runtime POINTER, not a copy of the contract: the full worker contract lives ONCE in
//      the system prompt (workerPrompt.ts) the server injects at spawn. This carries only what a
//      static system prompt can't: the runtime scratch-directory PATH, and a one-line pointer.
//   2. the SCRATCH DIRECTORY — `.frizz/threads/<session_id>/`, a folder the worker may use as it likes.
//   3. on `compact` — a short re-grounding (compaction drops the deep model + this orientation).
//
// GATE: everything is gated on FRIZZ_THREAD being set, so the plugin is completely inert when
// loaded outside a frizz worker (e.g. a plain `claude --plugin-dir cc-worker` smoke run).
//
// STALE-INSTALL DEFENSE: the `cc` orchestrator plugin is retired — the marketplace ships only this
// worker plugin, and cc's hooks/skills/agents are gone. But a machine can still carry a CACHED cc
// install from before the retirement, whose hooks fire in every repo gated on cc's opt-IN sentinel.
// A fresh worker never runs `frizz on`, so such a cc is already dormant; we write cc's own per-session
// `off` sentinel anyway via the shared config API (board survives as cc-worker's board
// implementation) so a stale install is guaranteed inert. Cheap belt-and-suspenders. See DECISIONS.md.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setSessionOverride, currentSessionId } from '../scripts/frizz/config.mjs';

/** @type {{ agent_id?: unknown, agentId?: unknown, source?: string, session_id?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → input stays {} → proceed (fail-open to inject) */
}
// Skip inside sub-agent contexts (they carry agent_id) — the seed is for the top-level worker.
if (input.agent_id ?? input.agentId) process.exit(0);

// WORKER GATE — inert unless this is a frizz worker session.
const thread = (process.env.FRIZZ_THREAD ?? '').trim();
if (!thread) process.exit(0);

const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';

// Neutralize the orchestrator cc plugin for THIS session (defensive; see header + DECISIONS.md).
// The session id also names the worker's scratch directory (`.frizz/threads/<session_id>/`).
let sid = null;
try {
  sid = currentSessionId(input.session_id);
  // Never into a project folder that has gone: CLAUDE_PROJECT_DIR keeps the old path after a rename,
  // and the sentinel's `mkdir -p` would recreate it as an empty stub (see scratchpad.mjs).
  if (sid && existsSync(dir)) setSessionOverride(dir, sid, 'off');
} catch {
  /* best-effort — a failed sentinel write just leaves cc at its dormant default */
}
const scratch = sid
  ? '.frizz/threads/' + sid + '/'
  : '.frizz/threads/<session-id>/';

// A RUNTIME pointer, NOT a copy of the contract. The full worker contract (signal fences,
// scratch-directory rules, sub-agent rules, the question handback, the stop criterion) lives ONCE in
// the system prompt frizz injects at spawn (workerPrompt.ts / loadWorkerPrompt) — re-applied on every
// resume, and it survives compaction. This hook adds only what a static system prompt CANNOT carry:
// the runtime-derived scratch-directory PATH, plus (below) the compaction re-read nudge and the
// auth-gated gh guidance.
//
// It used to restate the fence protocol, the stop criterion and the autonomy rule in full — ~4.4 KB
// (~1,100 tokens) on every startup, resume, clear AND compact, all of it already in the 42 KB system
// prompt. Trimmed 2026-08-26 (maintainer: "Definitely trim the session seed hook if it's fully
// repetitive") as part of cutting the per-session token overhead Frizz adds over a plain TUI session.
const core =
  '⟦frizz worker contract⟧ You are a frizz WORKER driving EXACTLY ONE effort. Your FULL operating contract — the end-of-turn signal fences (```done / ```awaiting), the ```question fence that asks the human (a new `id:` registers a question where you write it; an `id:` alone references one you asked before), the scratch-directory rules, the sub-agent rules, the question handback and the stop criterion — lives in your SYSTEM PROMPT; follow it there. ALWAYS SIGN OFF — a fence OR a registration (`frizzctl done`, or a question you ask or reference at this rest, which is the sign-off: rest normally). A rest on running work takes the ```awaiting fence with `status: working|watching|needs_input` — `working` and `watching` are quiet parks and need no write-up.\n' +
  'SCRATCH DIRECTORY (OPTIONAL): `' + scratch + '` — a folder kept FOR YOU, nothing in it read automatically, never a substitute for doing the work. Give each sub-agent its OWN file rather than a shared one.';

const grounding =
  '⟦frizz worker re-grounding (post-compaction)⟧ Context was just compacted. You are still the frizz worker for effort `' + thread + '` — read whatever you left yourself in `' + scratch + '` NOW to recover your working state and to-do list before asserting anything, and re-read any code before claiming how it is structured. Your system prompt still carries the full contract; sign off as it says.';

// AUTH-GATED gh guidance — teach the worker to use `gh` well, but ONLY when signed in.
// Shell `gh auth status --active`: exit 0 = an active gh account is authenticated. The whole gate is
// wrapped so it can NEVER throw into SessionStart, and it fails CLOSED — no gh binary, not authed, a
// stall past the timeout, or any other error → we inject NOTHING (guidance is absent, not stale/wrong).
// It re-evaluates on every start/resume/clear/compact, so a later `gh auth login` starts injecting on
// the next turn boundary (and a `gh auth logout` stops it). See DECISIONS.md / plan §8.
const ghBlock =
  '⟦gh available⟧ You are signed into the `gh` CLI and in a GitHub repo. Use `gh` EAGERLY and well — it is the fastest path to issue/PR/CI/release context, and you should reach for it before guessing:\n' +
  '• READ freely: `gh issue view N -R OWNER/REPO --comments`, `gh pr view N`, `gh pr diff N`, `gh pr checks N`, `gh run list`/`gh run view`, `gh api repos/OWNER/REPO/…`. Prefer `--json <fields>` over scraping human text.\n' +
  '• SEARCH across the repo (and GitHub) with `gh search issues`/`gh search prs` when hunting related work, duplicates, or prior art.\n' +
  '• READ-ONLY BOUNDARY: never comment, label, assign, close, review, approve, or merge — no mutation of any kind — UNLESS the human explicitly asks in this session. Default to producing your findings/review as your final message, not as a GitHub post.\n' +
  'Load the `frizz:gh` skill for the full playbook (recipes + explicit project-local monitor selection + native Monitor/background-Bash CI/PR watches).';

let ghAuthed = false;
try {
  execFileSync('gh', ['auth', 'status', '--active'], { stdio: 'ignore', timeout: 4000 });
  ghAuthed = true;
} catch {
  /* no gh / not authed / stalled → fail CLOSED: leave ghAuthed false, inject nothing */
}

const parts = [core];
if (input.source === 'compact') parts.push(grounding);
if (ghAuthed) parts.push(ghBlock);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  }),
);
process.exit(0);
