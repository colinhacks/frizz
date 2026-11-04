#!/usr/bin/env node
// @ts-check
// SCRATCH-DIRECTORY hook (frizz-worker) — keeps a worker aware of the per-thread scratch directory
// (`.frizz/threads/<sid>/`) it may use, and re-orients it on that directory when its context is lost.
// Run directly with node (zero deps, max Node compat), mirroring the other hooks in this plugin.
//
// WHAT THIS USED TO BE, AND WHY IT IS NOT ANY MORE. Until 2026-08-06 frizz provisioned ONE canonical
// `scratch.md` per thread and this hook spliced its HEAD into the context window after every compaction,
// on the argument that a bare "remember to read your scratchpad" routes recovery through a decision the
// model can skip. That argument was sound and the mechanism still lost: it made a maintained file the
// price of admission for every worker, it needed a merge-only contract per backend to keep sub-agents
// from clobbering it, and the injection was invisible to the operator, who could neither see nor change
// what their worker would be told.
//
// The maintainer's replacement (chosen deliberately over keeping a canonical doc): the thread gets a
// free-form scratch DIRECTORY, and compaction recovery moves to `frizzctl goal`'s
// post-compaction trigger — the worker writes whatever doc it likes and LINKS it in a prompt frizz
// re-sends when the context is summarized away. Durable in SQLite, visible in the thread footer,
// editable by the human. This hook's job is therefore reduced to two honest things:
//
//   1. TELL the worker the directory exists, and that the arming is what makes anything in it come back.
//   2. On compact/resume, say what is IN the directory — a listing, not the content. That is the
//      degradation the maintainer accepted when choosing this over a canonical doc, and it is stated
//      here rather than quietly re-implemented as an injection: a worker that never armed the trigger
//      gets a pointer it may skip. Naming the files it already wrote is the most a pointer can do.
//
// CODEX CHILD EPILOGUE — native Codex sub-agents inherit the root conversation's system/user
// instructions even with `fork_turns:"none"`. The `subagent-start` mode is what tells such a child to
// write its OWN file rather than treating a document it did not create as its own. It also carries the
// codex half of the default-off nesting rule (2026-08-04): a native child does the work itself and does
// not `spawn_agent` a layer of its own unless its task said to. SubagentStart is the only structural
// seam that reaches a native child, the way agent-dispatch.mjs's epilogue is for Claude.
//
// THE WRITE-SIDE NUDGE — two channels:
//   UserPromptSubmit — the turn boundary.
//   PostToolUse      — MID-TURN, and this is the one that matters. A frizz worker runs enormous
//                      autonomous turns (dozens of tool calls between human prompts), so a
//                      turn-boundary-only nudge can miss an entire session's worth of work. PostToolUse
//                      additionalContext was verified live against cli 2.1.220: a real session quoted a
//                      sentinel injected after a Bash call. Both channels share one state file, so the
//                      interval is global — firing per tool call does NOT multiply the nudges.
//
// NO HOOK FIRES ON CONTEXT PRESSURE — measured, not assumed. Claude Code 2.1.220 exposes 31 hook
// events and not one of them signals an approaching context limit; no hook input carries a token
// count at all (the docs say plainly: poll the transcript yourself). So this computes the fill
// itself from the transcript's newest usage record — `input + cache_creation + cache_read` is the
// live context size — reading only the file's TAIL, since transcripts reach tens of megabytes.
//
// STALENESS IS GROWTH SINCE THE LAST WRITE, never an absolute threshold: the window size is not
// knowable from a hook (a real compaction in this project fired at preTokens 935,291 on a 1M-window
// session, while a 200k session compacts near 160k). Growth is window-independent and self-resetting.
//
// NOT A BLOCKING GATE. A Stop hook could refuse to let the worker rest until it writes, and that was
// tried and REMOVED on 2026-07-02 (maintainer's call): the block-until-file-edited nag forced even
// trivial workers into Read/Edit dances that render as noise in the chat UI. This nudges; it never
// blocks.
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { currentSessionId } from '../scripts/frizz/config.mjs';

/** How many filenames a listing names before it summarizes the rest. A worker with 200 scratch files
 *  needs to know that, not to be handed 200 lines of them. */
const MAX_LISTED_FILES = intFromEnv('FRIZZ_SCRATCH_MAX_LISTED', 40);

/** Context-token growth since the last scratch write that marks the directory stale. 60k is ~a third of
 *  a 200k window and ~6% of a 1M one: frequent enough that a long effort is reminded while there is
 *  still something to record, rare enough not to be chatter. Also the first-write trigger — an EMPTY
 *  directory has no clock of its own, so the baseline is zero and the first nudge lands once a session
 *  has accumulated 60k tokens actually worth persisting. */
const STALE_TOKENS = intFromEnv('FRIZZ_SCRATCHPAD_STALE_TOKENS', 60000);

/** @param {string} name @param {number} fallback */
function intFromEnv(name, fallback) {
  const n = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const argv = process.argv.slice(2);
/** @param {string} flag */
const flagValue = (flag) => {
  const hit = argv.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
};
const mode = flagValue('--mode') ?? 'session-start';
const via = flagValue('--via') ?? 'plugin';

// ALWAYS ON — deliberately not settings-gated. The scratchpad is the CANONICAL document for a thread,
// so re-grounding on it after a compaction is not an opinion a project opts into; it is what makes the
// pad worth writing at all. An earlier revision put this behind an opt-in setting that defaulted OFF,
// which meant the default worker got nothing back after a compaction — the exact failure the pad
// exists to prevent (maintainer's correction: the thing that should be opt-in is the FORK-based
// auto-updating, not the re-grounding).
//
// The escape hatch is an env var, not a setting, because it is for a one-off ("this session is doing
// something where the injection is in the way"), not a project posture. Anything affirmative-looking
// is ignored: only an explicit off value disables.
if (/^(off|0|false|no|disabled)$/i.test((process.env.FRIZZ_SCRATCHPAD_HOOK ?? '').trim())) process.exit(0);

// The repo-local registration defers to the plugin one for frizz workers (see --via, and the
// registration note in DECISIONS.md) so a frizz worker never injects twice.
if (via === 'project' && (process.env.FRIZZ_THREAD ?? '').trim()) process.exit(0);

/** @type {{ agent_id?: unknown, agentId?: unknown, source?: string, trigger?: string, session_id?: string, transcript_path?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → fall back to env for the session id */
}
const childId = input.agent_id ?? input.agentId;
// Sub-agent contexts are silent on every reinforcement mode. The child-only epilogue is the one
// exception: it constrains the undifferentiated scratchpad instruction the child otherwise inherits.
if (childId && mode !== 'subagent-start') process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// WHICH session keys the pad. On Claude the hook's `session_id` IS frizz's thread session id, so the
// derived path is correct. On CODEX it is NOT: codex reports its own rollout session id (measured —
// e.g. `019fb427-93aa-…`, with transcript_path pointing into ~/.codex/sessions), which has nothing to
// do with `.frizz/threads/<frizz sessionId>/scratch.md`. Deriving the path there would silently address
// a pad that does not exist and the worker would look unreinforced for a reason nobody could see. So
// frizz bakes `--session=<frizz sessionId>` into the codex hook command, and an explicit value always
// wins over the reported one.
const explicitSession = flagValue('--session');
let sid = null;
try {
  sid = explicitSession || currentSessionId(input.session_id);
} catch {
  /* best-effort */
}
// Without a session id there is no key, and an unkeyed pad would bleed between sessions.
if (!sid) process.exit(0);

const threadDir = join(projectDir, '.frizz', 'threads', sid);
const relPath = '.frizz/threads/' + sid + '/';

// ── mode: subagent-start (Codex child-only merge epilogue) ───────────────────────────────────────
if (mode === 'subagent-start') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext:
        '⟦scratch directory — write your OWN file⟧ `' + relPath + '` is a scratch directory shared with ' +
        'the top-level `/root` worker and any sibling agents. If you want notes on disk, create your ' +
        'own file in it — never edit, replace or delete a file another agent wrote, and never treat a ' +
        'document you did not create as yours to rewrite. One file per writer means there is nothing ' +
        'to merge and nothing to clobber. Writing your own file here is Frizz coordination state, not ' +
        'a project deliverable or source edit: it remains allowed when a delegated task limits your ' +
        'deliverable paths with phrases such as “write only <path>” or “do not modify the repo”, and ' +
        'must never be classified as unauthorized or rolled back. Other project files, including files ' +
        'at the repository root, remain governed by your delegated authority; their location alone ' +
        'neither permits nor forbids editing.\n' +
        '⟦no fan-out of your own⟧ Do the work yourself: do not spawn agents of your own ' +
        '(`spawn_agent`) unless the task you were given explicitly tells you to. You are already one ' +
        'prong of the root worker’s fan-out, and another layer below you splits the context you were ' +
        'handed and buries the real work further from whoever reads the tree. A slice that feels ' +
        'large is still yours to work through.',
    },
  }));
  process.exit(0);
}

// Claude Code fixes CLAUDE_PROJECT_DIR when the session starts, so it still names the old path after
// the project's folder is renamed. Writing there would `mkdir -p` an empty stub of the old folder, and
// Claude Code then moves the session's working directory into that stub. A folder that has gone gets
// nothing: Frizz leaves a link at the old path while a worker from before the rename runs, and retires
// the worker into the new folder at its next rest (packages/server/src/project-relocation.ts).
if (!existsSync(projectDir)) process.exit(0);

// Ensure the directory exists so a first Write lands. frizz's dispatcher already provisions this for
// a real thread; this only covers a session that started outside a dispatch.
try {
  mkdirSync(threadDir, { recursive: true });
} catch {
  /* a read-only or racing FS just means the agent's Write creates it instead */
}

/** The worker's own files in the scratch directory, newest first — name, size, and how long ago it was
 *  touched. Dotfiles are excluded: frizz keeps its own per-thread bookkeeping in here
 *  (`.scratchpad-state.json`), and reporting that back to the worker as its own notes would be a lie.
 *  @returns {{ name: string, size: number, mtimeMs: number }[]} */
function listScratch() {
  let names;
  try {
    names = readdirSync(threadDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const st = statSync(join(threadDir, name));
      if (!st.isFile()) continue;
      out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between the listing and the stat — simply not listed
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The listing as text: what the worker actually has to go back to. NAMES ONLY, never content — see
 *  the header for why this hook points rather than injects.
 *  @param {{ name: string, size: number }[]} files */
function describe(files) {
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => '  - `' + relPath + f.name + '` (' + f.size + ' bytes)');
  if (files.length > shown.length) shown.push('  - …and ' + (files.length - shown.length) + ' more');
  return shown.join('\n');
}



/** @param {string} additionalContext @param {'SessionStart'|'UserPromptSubmit'|'PostToolUse'} hookEventName */
function emitJson(additionalContext, hookEventName) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
  process.exit(0);
}

// ── mode: session-start ──────────────────────────────────────────────────────────────────────────
if (mode === 'session-start') {
  // A CODEX resume loses nothing: the thread is rebuilt from its rollout with the whole conversation in
  // it, and Frizz resumes a thread routinely — its first message after every Frizz restart, and again
  // when a newer Frizz hands it new hooks. Telling that worker "Context was just lost" would be false
  // every time, so the Codex registration says so with a flag and this stays silent. (On Claude a
  // resume is a cold start of the process and keeps the wording below.)
  if (input.source === 'resume' && argv.includes('--resume-keeps-context')) process.exit(0);
  const files = listScratch();
  const written = files.length > 0;

  // The sources where the deep model of the work is actually GONE.
  const lostContext = input.source === 'compact' || input.source === 'resume' || input.source === 'clear'

  // Claude Code opens every compaction summary with the fixed preamble "This session is being
  // continued from a previous conversation that ran out of context." That sentence is about the
  // conversation just SUMMARIZED, but it lands at the moment the window is emptiest, and workers read
  // it as a report on their own state and start winding down. Measured: nub session 5258ebe4 took the
  // auto-compaction at line 20239 and then declared "I'm out of context" / "I'm at the end of this
  // context window" on 13 consecutive turns at fills of 176k-244k, before self-diagnosing at line
  // 20628 — "I've been treating 'low context' as a stopping condition ... and winding down instead of
  // working." Kept to two sentences: the re-grounding instruction is the payload.
  const compactedNote =
    input.source === 'compact'
      ? ' The summary opens "a previous conversation that ran out of context" — that describes the ' +
        'conversation just summarized, not your situation now: this window is close to EMPTY again, ' +
        'and the harness will compact and continue as many times as the effort needs. Context is not ' +
        'a reason to wind down, hand off, or leave the next step to a fresh session.'
      : ''

  const parts = [];
  if (lostContext && written) {
    // NAMES, NOT CONTENT. This is the pointer the maintainer accepted in place of an injection when
    // the canonical pad was dropped; the guaranteed channel is now the recurring prompt's
    // post_compaction trigger, which the worker arms for itself. Saying which files exist is the most
    // a pointer can do, and it is worth doing: a worker that wrote three docs and lost its context
    // otherwise has no idea they are there.
    parts.push(
      '⟦scratch directory⟧ Context was just ' + (input.source === 'compact' ? 'compacted' : 'lost') +
        '. You have files in your scratch directory `' + relPath + '`:\n' + describe(files) +
        '\n\nRead whichever of them bears on what you were doing BEFORE acting, and treat what you ' +
        'wrote there as authoritative over anything the summary implies. (A goal armed with ' +
        '`frizzctl goal start --post-compaction` can hand a link back at the next ' +
        'compaction without relying on this note.)' +
        compactedNote,
    );
  } else if (lostContext) {
    // Context is gone and the worker left itself nothing. Say so plainly and constrain reconstruction:
    // searching neighbouring threads' directories is both expensive and unsafe — they belong to
    // unrelated workers.
    parts.push(
      '⟦scratch directory⟧ Context was just compacted or resumed, and your scratch directory `' +
        relPath + '` is EMPTY — you left yourself nothing to recover from. Do not search other ' +
        '`.frizz/threads/*/` directories for a substitute, and do not broadly reload repo docs or ' +
        'skills merely to reconstruct context. Recover from the retained compaction summary and any ' +
        'task-specific handoff it directly names. The directory is still available if you want notes ' +
        'this time, and a goal armed with `frizzctl goal start --post-compaction` can ' +
        're-send a prompt linking them at the next compaction.' +
        compactedNote,
    );
  } else {
    // A fresh start has lost nothing — say what is available and move on. The directory is offered,
    // never prescribed (maintainer 2026-08-28: stop pushing the notes-plus-arming arrangement).
    parts.push(
      '⟦scratch directory⟧ `' + relPath + '` is yours: any files you like, no format expected, and ' +
        'nothing in it is read automatically. Use it if you want it. If you ever want a note to come ' +
        'back after a compaction, a goal armed with `frizzctl goal start ' +
        '--post-compaction` re-sends a prompt of your choosing — one that can link a file here.',
    );
  }
  emitJson(parts.join('\n\n'), 'SessionStart');
}

// ── mode: precompact ─────────────────────────────────────────────────────────────────────────────
// PLAIN STDOUT — handed to the summarizer as its `Additional Instructions:`. cc's usual
// `hookSpecificOutput` JSON would be read as literal instructions instead. Worded as an ordinary
// editorial note: a summarizer REFUSES instructions that read like prompt-hijacking (DECISIONS.md).
// This is the ONLY PreCompact hook the plugin registers — `precompact-instructions.mjs`, which also
// steered the summarizer, was deleted on 2026-08-26 as too opinionated.
if (mode === 'precompact') {
  const files = listScratch();
  if (files.length === 0) process.exit(0);
  process.stdout.write(
    'The worker kept working notes for this effort in `' + relPath + '`:\n' + describe(files) +
      '\nThose files are the hand-written account of the problem, the chosen approach and the ' +
      'decisions behind them. Make sure the summary preserves the substance of the work they describe, ' +
      'and name their paths in it so the continuing session can open them.\n',
  );
  process.exit(0);
}

// ── nudge modes (UserPromptSubmit + PostToolUse) ─────────────────────────────────────────────────
// Everything below answers one question: has the context moved on since the pad was last written?

/** Live context fill in tokens from the transcript's newest usage record, or null.
 *  Reads only the TAIL — transcripts reach tens of megabytes, and on PostToolUse this runs after
 *  every single tool call. Scanning backwards means the one line the tail read may have cut in half
 *  is reached last, and its parse failure is simply skipped.
 *  @param {string} path */
function contextTokens(path) {
  let fd = null;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(want);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.message?.usage;
      if (!u) continue;
      const n =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const statePath = join(threadDir, '.scratchpad-state.json');
/** @returns {{ mtimeMs?: number, tokensAtWrite?: number, tokensAtNudge?: number }} */
function readState() {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
/** @param {{ mtimeMs?: number, tokensAtWrite?: number, tokensAtNudge?: number }} s */
function writeState(s) {
  try {
    writeFileSync(statePath, JSON.stringify(s) + '\n');
  } catch {
    /* best-effort — a lost state file costs at most one extra nudge */
  }
}

if (mode === 'nudge') {
  const transcript = input.transcript_path;
  const tokens = transcript ? contextTokens(transcript) : null;
  // No readable usage yet, or an unparseable transcript → say nothing. The nudge is an optimization;
  // silence is always safe.
  if (!tokens) process.exit(0);

  const files = listScratch();

  // The NEWEST write across the whole directory is the clock. A worker with several docs has "written
  // recently" if it touched ANY of them — the nudge asks whether the effort is being recorded at all,
  // not whether one particular file moved. Zero when the directory is empty.
  const mtimeMs = files.length ? Math.max(...files.map((f) => f.mtimeMs)) : 0;

  let state = readState();
  // A changed mtime means something was just written — rebase the baseline to NOW and go quiet. This is
  // also the first-ever observation, and it is why a fresh write buys a full interval of silence. It
  // fires for a human's hand-edit exactly as for the agent's Write: both are just an mtime change.
  if (state.mtimeMs !== mtimeMs) {
    state = { mtimeMs, tokensAtWrite: tokens, tokensAtNudge: 0 };
    writeState(state);
  }

  // An EMPTY directory measures growth from ZERO: the whole session is unrecorded, so the clock starts
  // at the beginning, not at whenever this first looked.
  const baseline = mtimeMs ? (state.tokensAtWrite ?? tokens) : 0;
  const grown = tokens - baseline;
  if (grown < STALE_TOKENS) process.exit(0);
  // Space repeat nudges by the same interval. Both channels share this state, so firing on every tool
  // call does not multiply reminders — it only makes the existing budget land sooner and mid-turn.
  if (state.tokensAtNudge && tokens - state.tokensAtNudge < STALE_TOKENS) process.exit(0);

  writeState({ ...state, tokensAtNudge: tokens });

  const k = Math.round(grown / 1000);
  const event = /** @type {'UserPromptSubmit'|'PostToolUse'} */ (
    input.transcript_path && flagValue('--event') === 'PostToolUse' ? 'PostToolUse' : 'UserPromptSubmit'
  );
  emitJson(
    mtimeMs
      ? '⟦scratch notes stale⟧ Your context has grown ~' + k + 'k tokens since you last wrote anything ' +
          'in `' + relPath + '`. Top the notes up in passing if you still want them current (a goal ' +
          'armed with `frizzctl goal start --post-compaction` can link them). This is a background note, NOT a task and ' +
          'NOT a reason to pause: do not stop working to service it, and never end a turn on it while ' +
          'the human\'s instruction still has parts left.'
      : '⟦scratch directory empty⟧ This session is ~' + k + 'k tokens deep and `' + relPath + '` is ' +
          'empty. That is fine — notes are optional and writing them is not doing the work. The ' +
          'directory is available if you want notes, and `frizzctl goal start ' +
          '--post-compaction` can re-send a prompt linking them after a compaction. This is a ' +
          'background note, NOT a task and NOT a reason to pause: keep going with what you were asked to do.',
    event,
  );
}

process.exit(0);
