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
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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

// AUTH-GATED gh guidance — teach the worker to use `gh` well, but ONLY when it can actually reach GitHub.
// TWO TIERS, checked in order (2026-11-04, see DECISIONS.md):
//   1. Plain `gh auth status --active` exits 0 — an active gh account is signed in, as on any machine
//      that never adopted Keyward. Inject the plain block.
//   2. Otherwise, a `keyward` executable on PATH — the maintainer's Secure Enclave vault, which hands gh
//      its token in `GH_TOKEN` for one run at a time, so plain gh is signed OUT by design. Inject the
//      Keyward block: every gh command goes through `keyward --reason "…" -- gh …`.
// Neither → inject nothing. Tier 2 is found by walking PATH for the file, NEVER by running `keyward`:
// a release raises a Touch ID sheet, and a SessionStart hook must not put one on the maintainer's screen.
// The whole gate is wrapped so it can NEVER throw into SessionStart, and it fails CLOSED — no gh
// binary, a stall past the timeout, an unreadable PATH entry, or any other error → that tier is absent
// (guidance missing, not stale/wrong). It re-evaluates on every start/resume/clear/compact, so a later
// `gh auth login` or `gh auth logout` changes the block at the next turn boundary.
const ghReadOnly =
  '• READ-ONLY BOUNDARY: never comment, label, assign, close, review, approve, or merge — no mutation of any kind — UNLESS the human explicitly asks in this session. Default to producing your findings/review as your final message, not as a GitHub post.\n';

const ghBlock =
  '⟦gh available⟧ You are signed into the `gh` CLI and in a GitHub repo. Use `gh` EAGERLY and well — it is the fastest path to issue/PR/CI/release context, and you should reach for it before guessing:\n' +
  '• READ freely: `gh issue view N -R OWNER/REPO --comments`, `gh pr view N`, `gh pr diff N`, `gh pr checks N`, `gh run list`/`gh run view`, `gh api repos/OWNER/REPO/…`. Prefer `--json <fields>` over scraping human text.\n' +
  '• SEARCH across the repo (and GitHub) with `gh search issues`/`gh search prs` when hunting related work, duplicates, or prior art.\n' +
  ghReadOnly +
  'To wait on CI or reviews, register `frizzctl watch-pr add` / `frizzctl watch-issue add` rather than polling. Load the `frizz:gh` skill for the full playbook (recipes, waits, and the bundled monitors as a fallback).';

const ghFrizzReadOnlyBlock =
  '⟦gh available, read-only⟧ Plain `gh` is signed in here with Frizz\'s own READ-ONLY GitHub credential: no Touch ID, and it works while the screen is locked. Use it EAGERLY and well — it is the fastest path to issue/PR/CI/release context, and you should reach for it before guessing:\n' +
  '• READ freely: `gh issue view N -R OWNER/REPO --comments`, `gh pr view N`, `gh pr diff N`, `gh pr checks N`, `gh run list`/`gh run view`, `gh api repos/OWNER/REPO/…`. Prefer `--json <fields>` over scraping human text. Repo source is not readable through it; read the checkout.\n' +
  '• A WRITE fails with a permission error (`Resource not accessible by integration`, HTTP 403), and so does a read that needs more than it holds, such as a private repo on an account where Frizz\'s GitHub App is not installed (it reads as not found). That is this credential, not a fault: rerun that one command as `keyward --reason "<what this command is for>" -- gh …`, `gh` the first word after `--`. One Touch ID covers this repository for 10 minutes.\n' +
  '• On any stderr line starting `keyward: not released:` (screen locked, declined), STOP and report it to the human; NEVER retry. A locked screen does not clear by retrying, and a decline was their answer.\n' +
  ghReadOnly +
  'To wait on CI or reviews, register `frizzctl watch-pr add` / `frizzctl watch-issue add` rather than polling. Load the `frizz:gh` skill for the full playbook.';

// The same credential on a machine with no Keyward, where `gh` had no sign-in of its own, so a write has
// nowhere to go from here (frizzGithubWorkerEnv).
const ghFrizzReadOnlyNoWritesBlock =
  '⟦gh available, read-only⟧ Plain `gh` is signed in here with Frizz\'s own READ-ONLY GitHub credential. Use it EAGERLY and well — it is the fastest path to issue/PR/CI/release context, and you should reach for it before guessing:\n' +
  '• READ freely: `gh issue view N -R OWNER/REPO --comments`, `gh pr view N`, `gh pr diff N`, `gh pr checks N`, `gh run list`/`gh run view`, `gh run view <id> --log-failed`, `gh api repos/OWNER/REPO/…`. Prefer `--json <fields>` over scraping human text. Repo source is not readable through it; read the checkout.\n' +
  '• A WRITE fails with a permission error (`Resource not accessible by integration`, HTTP 403), and so does a read that needs more than it holds, such as a private repo on an account where Frizz\'s GitHub App is not installed (it reads as not found). That is this credential, not a fault, and this machine has no other GitHub sign-in: hand the write to the human as steps, with the exact command or page.\n' +
  ghReadOnly +
  'To wait on CI or reviews, register `frizzctl watch-pr add` / `frizzctl watch-issue add` rather than polling. Load the `frizz:gh` skill for the full playbook.';

const ghKeywardBlock =
  '⟦gh available through Keyward⟧ Plain `gh` is signed OUT here; Keyward, the human\'s vault, signs it in for one run at a time. Run EVERY gh command as `keyward --reason "<what this command is for>" -- gh …` (`gh` must be the first word after `--`). It is still the fastest path to issue/PR/CI/release context — reach for it before guessing:\n' +
  '• One Touch ID covers this repository\'s gh runs for 10 minutes (less if the screen locks), so BATCH your gh reads together rather than spreading them out. Prefer `--json <fields>`.\n' +
  '• On any stderr line starting `keyward: not released:` (screen locked, declined), STOP and report it to the human; NEVER retry. A locked screen does not clear by retrying, and a decline was their answer.\n' +
  '• WAITS: register `frizzctl watch-pr add` / `frizzctl watch-issue add` for CI and reviews — Frizz\'s server watches on its own credential, even while the screen is locked. Never poll gh; the bundled ci-watch/review-watch monitors cannot sign in under Keyward.\n' +
  ghReadOnly +
  'Load the `frizz:gh` skill for the full playbook (recipes and the exact Keyward failures).';

/** Whether `name` is an executable file in some PATH directory. Stats files only, runs nothing. */
function onPath(name) {
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d) continue;
    for (const ext of exts) {
      try {
        const file = join(d, name + ext);
        if (!statSync(file).isFile()) continue;
        if (!win) accessSync(file, constants.X_OK);
        return true;
      } catch {
        /* absent, unreadable or not executable → keep looking */
      }
    }
  }
  return false;
}

/** Frizz points a worker's GH_CONFIG_DIR at its own read-only credential where Keyward takes the writes.
 *  It marks that folder with a file: a FRIZZ_ variable would not reach every transport. Stats, no network. */
function frizzReadOnlyGh() {
  const dir = process.env.GH_CONFIG_DIR;
  if (!dir) return false;
  try {
    return statSync(join(dir, 'frizz-read-only')).isFile();
  } catch {
    return false;
  }
}

/** @type {'read-only' | 'plain' | 'keyward' | null} */
let ghMode = frizzReadOnlyGh() ? 'read-only' : null;
if (!ghMode) {
  try {
    execFileSync('gh', ['auth', 'status', '--active'], { stdio: 'ignore', timeout: 4000 });
    ghMode = 'plain';
  } catch {
    /* no gh / not authed / stalled → fall through to the Keyward tier */
  }
}
if (!ghMode) {
  try {
    if (onPath('keyward')) ghMode = 'keyward';
  } catch {
    /* fail CLOSED: inject nothing */
  }
}

const parts = [core];
if (input.source === 'compact') parts.push(grounding);
if (ghMode === 'read-only') parts.push(onPath('keyward') ? ghFrizzReadOnlyBlock : ghFrizzReadOnlyNoWritesBlock);
else if (ghMode === 'plain') parts.push(ghBlock);
else if (ghMode === 'keyward') parts.push(ghKeywardBlock);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  }),
);
process.exit(0);
