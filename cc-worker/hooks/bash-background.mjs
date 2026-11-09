#!/usr/bin/env node
// @ts-check
// PreToolUse hook on `Bash` (frizz-worker). Claude's native `run_in_background` flag registers a
// task, output file, terminal notification, and wake. Shell job control (`cmd &`) does none of those:
// the child can survive after the Bash tool returns, but Claude and frizz have no lifecycle identity
// for it. A worker can then rest forever waiting for a notification that cannot exist.
//
// Block only an ESCAPING local background job. Self-contained shell concurrency remains valid when
// the command explicitly waits for its children or owns them with an EXIT trap before Bash returns.
//
// GATE: inert unless FRIZZ_THREAD is set (ordinary Claude sessions keep their native behavior).
// FAIL OPEN: malformed hook input allows the command rather than wedging a worker.
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

/**
 * Blank heredoc bodies while preserving line/character positions. A script being WRITTEN may contain
 * `&`; only the shell currently executing this tool call is relevant to the lifecycle escape.
 * @param {string} command
 */
function withoutHeredocBodies(command) {
  const lines = command.split('\n');
  /** @type {string[]} */
  const pending = [];
  let active;
  return lines.map((line) => {
    if (active !== undefined) {
      if (line.trim() === active) {
        active = pending.shift();
        return line;
      }
      return ' '.repeat(line.length);
    }

    // Shell accepts quoted and bare heredoc delimiters. Multiple heredocs on one command line are
    // consumed in declaration order.
    for (const match of line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))/g)) {
      const delimiter = match[1] ?? match[2] ?? match[3];
      if (delimiter) pending.push(delimiter);
    }
    active = pending.shift();
    return line;
  }).join('\n');
}

/**
 * Replace quoted regions with spaces. Operators sent inside `ssh host '…'` are remote, and quoted
 * prose such as `printf '&'` is not local shell job control. Backticks are also synchronous command
 * substitutions from the outer shell's perspective.
 * @param {string} command
 */
function withoutQuotedRegions(command) {
  let quote = '';
  let escaped = false;
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) {
      out += quote ? ' ' : c;
      escaped = false;
      continue;
    }
    if (c === '\\' && quote !== "'") {
      out += quote ? ' ' : c;
      escaped = true;
      continue;
    }
    if (quote) {
      // Double quotes may contain a complete command substitution with its OWN quote grammar:
      // `"$(python -c 'print(f"{x&255}")')"`. Treating the f-string's double quote as the end of the
      // outer region exposed arithmetic `&` as fake job control in a real corpus call. The outer shell
      // waits for command substitution, so blank the balanced substitution as part of the quote.
      if (quote === '"' && c === '$' && command[i + 1] === '(') {
        out += '  ';
        i += 2;
        let depth = 1;
        let innerQuote = '';
        let innerEscaped = false;
        for (; i < command.length; i++) {
          const inner = command[i];
          out += inner === '\n' ? '\n' : ' ';
          if (innerEscaped) {
            innerEscaped = false;
            continue;
          }
          if (inner === '\\' && innerQuote !== "'") {
            innerEscaped = true;
            continue;
          }
          if (innerQuote) {
            if (inner === innerQuote) innerQuote = '';
            continue;
          }
          if (inner === "'" || inner === '"' || inner === '`') {
            innerQuote = inner;
            continue;
          }
          if (inner === '(') depth++;
          else if (inner === ')' && --depth === 0) break;
        }
        continue;
      }
      if (c === quote) quote = '';
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

// A LOCAL shell wrapper runs its script in THIS machine's process tree, so `bash -c 'job &'` escapes
// exactly as a bare `job &` does — the wrapper forks the job and exits. Blanking quoted regions is
// what exempts `ssh host '… &'` (that job is remote and the ssh client still waits), but it hid the
// local wrapper along with it, leaving a one-token bypass of the whole guard. So scan the sanitized
// text for a wrapper, then re-read its script from the ORIGINAL command and recurse.
//
// Only in COMMAND POSITION. A wrapper passed as an ARGUMENT belongs to whatever program precedes it,
// and that program decides where the script runs: `docker run img bash -c …` and
// `limactl shell vm bash -lc …` both appear in the real corpus, and neither backgrounds anything
// local. That is the same call the `ssh` exemption already makes. It costs the genuinely-local
// `xargs sh -c 'job &'`, which the corpus never shows, and under-blocking is the safer miss here.
const LOCAL_SHELL_SCRIPT = /(?:^|[\n;|&({])\s*(?:\/\S*\/)?(?:bash|sh|zsh|dash|ksh)(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*c(?=\s)/g;

/**
 * Read the quoted argument that begins at `from` in the original command, undoing only the escaping
 * the surrounding quote itself performs.
 * @param {string} raw @param {number} from
 */
function quotedArgumentAt(raw, from) {
  let i = from;
  while (raw[i] === ' ' || raw[i] === '\t') i++;
  const quote = raw[i];
  if (quote !== "'" && quote !== '"') return '';
  let out = '';
  for (i++; i < raw.length; i++) {
    if (raw[i] === '\\' && quote === '"' && i + 1 < raw.length) {
      out += raw[++i];
      continue;
    }
    if (raw[i] === quote) return out;
    out += raw[i];
  }
  return '';
}

/**
 * Return true when this Bash call starts a local background job and can return without joining or
 * terminating it. This is deliberately a small shell-lifecycle recognizer, not a general parser.
 * @param {unknown} raw
 * @param {number} depth
 */
export function hasEscapingBackgroundJob(raw, depth = 0) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const command = withoutQuotedRegions(withoutHeredocBodies(raw));
  /** @type {number[]} */
  const operators = [];
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== '&') continue;
    const before = command[i - 1] ?? '';
    const after = command[i + 1] ?? '';
    // `&&`, redirects (`2>&1`, `&>`), and an escaped literal are not background operators.
    if (before === '&' || after === '&' || before === '>' || before === '<' || after === '>' || before === '\\') continue;
    operators.push(i);
  }
  if (operators.length > 0) {
    // A lifecycle action AFTER the last launch makes the command self-contained. `kill` alone does
    // not: the signal is asynchronous, so the shell still needs a wait before returning. An EXIT trap
    // owns cleanup at the shell boundary.
    const tail = command.slice(operators[operators.length - 1] + 1);
    if (!(/\bwait\b/.test(tail) || /\btrap\b[^\n;]*\b(?:EXIT|0)\b/.test(tail))) return true;
  }

  // Both sanitizers substitute character-for-character, so a match position in the sanitized text
  // still indexes the original. A length mismatch would mean that invariant broke: fail open rather
  // than slice the wrong bytes. The depth cap bounds `sh -c 'sh -c …'` nesting.
  if (depth >= 3 || command.length !== raw.length) return false;
  // `matchAll` iterates a CLONE, so the module-level regex keeps no cursor for a nested call to reset
  // out from under this loop — `exec` on the shared object spins forever on `bash -c "sh -c '…'"`.
  for (const match of command.matchAll(LOCAL_SHELL_SCRIPT)) {
    const script = quotedArgumentAt(raw, match.index + match[0].length);
    if (hasEscapingBackgroundJob(script, depth + 1)) return true;
  }
  return false;
}

/**
 * The opening of every refusal below. The transcript parser reads it back out of the tool result to
 * tell a call this hook stopped, which launched nothing, from a `&` job that really escaped.
 */
export const BACKGROUND_JOB_REFUSAL = 'Frizz blocked an untracked shell background job';

export function evaluateBashBackgroundHook(input, env = process.env) {
  if (!String(env.FRIZZ_THREAD ?? '').trim()) return {};
  const command = input && typeof input === 'object'
    ? String(input.tool_input?.command ?? '')
    : '';
  if (!hasEscapingBackgroundJob(command)) return {};
  const codex = typeof input?.model === 'string';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        codex
          ? BACKGROUND_JOB_REFUSAL + ' (`&`). Shell job control can return without a Codex lifecycle handle, so Frizz cannot report completion or wake this agent. For work that must continue while you do something else, remove `&` and use the managed unified exec pattern: start `tools.exec_command(...)`, call `yield_control()`, then await and fully drain that same process. A returned `session_id` alone is only foreground continuation. For bounded parallel work inside one shell call, finish with `wait` (after `kill`, if used) or own cleanup with an EXIT trap.'
          : BACKGROUND_JOB_REFUSAL + ' (`&`). Shell job control can return from Bash without a Claude task ID, so Frizz cannot report completion or wake this agent. For a long-running local command, remove `&` and call Bash with `run_in_background:true`. For bounded parallel work inside one Bash call, finish with `wait` (after `kill`, if used) or own cleanup with an EXIT trap.',
    },
  };
}

// Compared through `realpath` on BOTH sides. Node realpaths the main entry, so `import.meta.url` is
// the long, resolved spelling, while `argv[1]` is whatever CLAUDE_PLUGIN_ROOT spelled — an 8.3 short
// name (`C:\Users\RUNNER~1\…`, common when a profile or %LOCALAPPDATA% is one), a junction, or a
// symlink. A plain URL comparison then fails and the hook emits NOTHING, which Claude reads as
// "allowed": the guard silently switched off (Windows audit 2026-09-11, finding 15). The cheap URL
// equality is kept as the first test; realpath is the tie-breaker, and a path that cannot be
// realpath'd is not this file.
export function isDirectHookExecution(argv1, moduleUrl, realpath = realpathSync) {
  if (typeof argv1 !== 'string' || basename(argv1) !== 'bash-background.mjs') return false;
  if (pathToFileURL(argv1).href === moduleUrl) return true;
  try {
    return realpath(argv1) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// The server imports `hasEscapingBackgroundJob` and its production build bundles this module into
// `src/index.js`. esbuild rewrites `import.meta.url` to that bundle URL, so URL equality alone would
// mistake the whole server for this executable and block startup reading hook JSON from stdin.
if (isDirectHookExecution(process.argv[1], import.meta.url)) {
  try {
    const env = process.argv.includes('--frizz-thread')
      ? { ...process.env, FRIZZ_THREAD: process.env.FRIZZ_THREAD || 'codex-worker' }
      : process.env;
    emit(evaluateBashBackgroundHook(JSON.parse(readFileSync(0, 'utf8')), env));
  } catch {
    emit({});
  }
}
