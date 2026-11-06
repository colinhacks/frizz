#!/usr/bin/env node
// @ts-check
// PermissionRequest hook (frizz worker), matcher "*" — the worker's permission POLICY, and the durable
// structured signal the tailer reads instead of scraping the worker's terminal output.
//
// WHY THIS DECIDES (it used to only observe): a frizz worker runs under a dashboard with nobody at the
// keyboard, so a tool-approval prompt parks the thread invisibly until a human happens to look. Under
// `bypassPermissions` this approves what Claude Code still asks about, because the operator chose not to
// be asked. Under `auto`, the default since 2026-11-06, the classifier has already allowed or refused
// nearly everything by the time a request gets here, and what is left goes to a person: see the
// `auto-escalation` rule. Claude Code labels an approval in the transcript ("Allowed by PermissionRequest
// hook"), so one stays visible rather than being indistinguishable from no check at all.
//
// THREE OUTCOMES:
//   allow  — auto-approve; the worker proceeds with no prompt.
//   deny   — auto-refuse with a reason the model reads (rides top-level `additionalContext`).
//   defer  — emit NOTHING; the normal prompt is raised and a human answers it. This is the ONLY
//            outcome the tailer treats as a human block (see permMarkerBlocks in tailer.ts).
//
// SCOPE: this plugin loads for EVERY project frizz drives, so the built-in table carries only
// UNIVERSAL rules. Nothing repo-specific belongs here — a rule that is right for one repo (e.g. "never
// open a PR") is wrong for the next.
//
// KNOWN LIMIT — an explicit `ask` RULE outranks this hook. A project or user settings entry like
// `"permissions": {"ask": ["Bash(git push:*)"]}` is not overridden by an `allow` from here. In 2.1.318
// that allow refuses the call outright ("Claude requested permissions to use Bash, but you haven't
// granted it yet", measured 2026-11-06), where 2026-07-25's build raised a prompt. An `auto` thread defers
// instead, so the rule gets the card it asks for; a `bypassPermissions` thread still gets the refusal.
// Mode-driven asks (the `default`-mode prompt) ARE overridden.
//
// GATE: inert unless FRIZZ_THREAD is set, so a foreign/non-frizz session is never affected.
// FAIL-SAFE: any error at all → emit nothing → the prompt is raised and the human decides. Note this
// inverts the old observer's "fail open": for a hook that can APPROVE, the safe failure is to fall
// back to asking, never to allow.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const slug = process.env.FRIZZ_THREAD;
if (!slug) process.exit(0);

// Top-level targets whose recursive deletion is unrecoverable. `/tmp/x` and `./build` are NOT here —
// only paths that take the machine or the home directory with them.
const ROOTISH =
  /^(\/|\/\*|~|~\/|~\/\*|\$\{?HOME\}?|\$\{?HOME\}?\/\*?|\/(usr|etc|bin|sbin|var|lib|opt|System|Library|Applications|Users|home|boot|dev|proc)\/?\*?)$/;

// True when `cmd` contains an `rm` that is BOTH recursive and forced AND aimed at a root-ish target.
// Scans each pipeline/list segment so `cd /tmp && rm -rf /` is caught as readily as a bare `rm -rf /`.
function isCatastrophicRm(cmd) {
  for (const seg of cmd.split(/[|;&\n]+/)) {
    const m = /(?:^|\s)rm(\s.*)$/.exec(seg);
    if (!m) continue;
    const rest = m[1];
    const flags = (rest.match(/(?:^|\s)-[a-zA-Z]+/g) || []).join('');
    if (!/[rR]/.test(flags) || !/f/.test(flags)) continue;
    const targets = rest.split(/\s+/).filter((t) => t && !t.startsWith('-'));
    if (targets.some((t) => ROOTISH.test(t.replace(/["']/g, '')))) return true;
  }
  return false;
}

// Writes straight to a raw device / formats a filesystem — unrecoverable, and never something a
// worker needs to do unattended.
function isDiskWrite(cmd) {
  return /\bmkfs(\.\w+)?\b/.test(cmd) || /\bdd\b[^|;&]*\bof=\/dev\/(disk|r?disk|sd|nvme|hd)/.test(cmd);
}

// The worker's OWN Frizz command fed by a quoted heredoc, and provably nothing else:
//
//     frizzctl ask --input - <<'EOF'
//     {"question": "…", "options": […]}
//     EOF
//
// Dispatch pre-approves `Bash(frizzctl:*)` (dispatch.ts claudeCliConfig), which is the promise the Frizz
// MCP server's own pre-approval made before 2026-10-11: a worker's sign-off, its question and its
// registrations are never something a human has to approve. Claude Code honours that rule for every
// form but one. Measured on 2.1.296 against a real worker on a `default`-mode thread
// (`_live_broker_frizzctl.mts`): a bare call, an inline JSON argument, `--input <file>`, `< file`,
// `frizzctl … && frizzctl …` and a quoted heredoc of PROSE all ran unasked, and a quoted heredoc whose
// body holds a JSON object raised a prompt — Claude Code's own command checks read the braces and
// quotes of a body the shell never interprets. That was the one shape `ask` most needed, since a
// question's options do not fit on a command line; `ask` refuses since 2026-10-13 (a question is a
// ```question fence the worker writes), and the shape stays approved for every other `--input -`.
//
// So this recognises exactly that shape, and it is deliberately narrower than the rule it backs up.
// The first line is `frizzctl`, then words made only of characters the shell does not interpret, then
// `<<'WORD'` and the end of the line: no quoting to get wrong, no expansion, no operator, no second
// command. A QUOTED delimiter makes the body literal, so nothing in it runs however it reads. The body
// ends at the first line that is exactly WORD, which is bash's own rule, and only blank lines may
// follow. Anything else, `<<EOF` unquoted included, is not this and falls through to the table.
const FRIZZCTL_HEREDOC = /^frizzctl(?: +[A-Za-z0-9_.\/:=@%+,-]+)* +<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*\n([\s\S]*)$/;
function isOwnFrizzctlHeredoc(cmd) {
  // Blanks are the SHELL's — space, tab, newline — and not JavaScript's `\s`, which also takes a
  // no-break space or a form feed: to bash and zsh those are ordinary characters of a word, so
  // `\u00a0frizzctl` is a different program.
  const m = FRIZZCTL_HEREDOC.exec(cmd.replace(/^[ \t\n]+/, ''));
  if (!m) return false;
  const lines = m[2].split('\n');
  const end = lines.indexOf(m[1]);
  return end !== -1 && lines.slice(end + 1).every((line) => /^[ \t]*$/.test(line));
}

// The ordered policy table: FIRST MATCH WINS. Each rule returns a decision plus the `rule` id and
// `reason` that get recorded on the marker, so frizz can always say WHICH rule decided and WHY.
// `deny` reasons are written to be read by the MODEL (they become additionalContext).
const RULES = [
  {
    id: 'catastrophic-delete',
    test: (i) => i.tool_name === 'Bash' && isCatastrophicRm(String(i.tool_input?.command ?? '')),
    decision: 'deny',
    reason:
      'Refused: this recursively force-deletes a root-level or home directory, which is unrecoverable. If you genuinely need to remove a large tree, target an explicit project-relative path instead, and never `/`, `~`, or a top-level system directory.',
  },
  {
    id: 'raw-disk-write',
    test: (i) => i.tool_name === 'Bash' && isDiskWrite(String(i.tool_input?.command ?? '')),
    decision: 'deny',
    reason:
      'Refused: this formats a filesystem or writes directly to a raw block device, which destroys data irrecoverably and is never required of an unattended worker.',
  },
  {
    // Ahead of `restrictive-mode` on purpose: a thread a human moved to `default` still has to be able
    // to ask them a question and sign off without first asking permission to. See isOwnFrizzctlHeredoc.
    id: 'own-frizzctl',
    test: (i) => i.tool_name === 'Bash' && isOwnFrizzctlHeredoc(String(i.tool_input?.command ?? '')),
    decision: 'allow',
    reason: "The worker's own Frizz command, fed by a quoted heredoc: its questions, registrations and sign-off are pre-approved in every permission mode.",
  },
  {
    // Respect a DELIBERATELY restrictive mode. frizz dispatches workers at `auto`; a thread sitting at
    // `default`/`plan` got there because a human moved it there (the live per-thread permission
    // control), and auto-approving would silently overrule that intent. This is what makes a genuine
    // lower-permission mode usable today: switch a thread to `default` and its prompts come back.
    //
    // `bypassPermissions` IS NOT ONE OF THEM. It is the one mode MORE permissive than `auto`, and the
    // operator chose it (Settings, or the same per-thread control) precisely to stop being asked — but
    // Claude Code still raises a prompt for some commands under bypass, and this rule read "not auto"
    // as "restrictive", so a bypass thread parked on approval cards an auto thread never showed
    // (maintainer 2026-10-10: all four markers on the machine that day were bypass-mode defers). It
    // falls through to `worker-autonomy` now, behind the two refusals above. Any OTHER mode string,
    // including one this table has never heard of, still defers: unknown must mean ask.
    id: 'restrictive-mode',
    test: (i) =>
      typeof i.permission_mode === 'string' && i.permission_mode !== 'auto' && i.permission_mode !== 'bypassPermissions',
    decision: 'defer',
    reason: 'The thread is in a restrictive permission mode, so this request is left for a human to answer.',
  },
  {
    // Escape hatch for review-style operation without changing how workers launch.
    id: 'review-policy',
    test: () => (process.env.FRIZZ_PERM_POLICY ?? 'auto').toLowerCase() === 'review',
    decision: 'defer',
    reason: 'FRIZZ_PERM_POLICY=review — every request is left for a human to answer.',
  },
  {
    // WHAT AUTO MODE WILL NOT DECIDE GOES TO A PERSON, it is not approved here (2026-11-06). In `auto` the
    // classifier answers first, so a request reaches this hook only when Claude Code is asking a person in
    // the classifier's place. One of those is its denial limit: after 3 refusals in a row or 20 in a session
    // it falls back to asking (`Abn` in 2.1.318, which leaves hooks free to allow). Approving here turned a
    // refusal into a retry count. The others are an explicit `ask` rule, which this hook's allow turned into
    // a bare refusal, and a conversation too long for the check. This used to fall through to
    // `worker-autonomy` because one parked card once stalled a thread for a day, on a CLI whose classifier
    // prompted instead of refusing; a card now lapses into a denial after 5m (claude-permission-interactions.ts
    // CLAUDE_PERMISSION_DEADLINE_MS), so the most an unanswered one costs is 5m. Rare in practice: 1 of 57
    // real `auto` threads on the maintainer's board had one, against 11,842 tool calls.
    id: 'auto-escalation',
    test: (i) => i.permission_mode === 'auto',
    decision: 'defer',
    reason: 'Auto mode left this request for a person to answer.',
  },
  {
    id: 'worker-autonomy',
    test: () => true,
    decision: 'allow',
    reason: 'Unattended frizz worker: approved automatically because no human is watching the terminal to answer a prompt.',
  },
];

function evaluate(input) {
  for (const rule of RULES) {
    let hit = false;
    try {
      hit = rule.test(input);
    } catch {
      continue; // a throwing rule is skipped, never fatal
    }
    if (hit) return { decision: rule.decision, rule: rule.id, reason: rule.reason };
  }
  return { decision: 'defer', rule: 'no-rule-matched', reason: 'No policy rule matched.' };
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // unparseable payload → defer to the human
}

// ExitPlanMode is always auto-denied by the sibling deny-plan.mjs (a frizz worker is never in plan
// mode), so it never becomes a real human block — leave it entirely alone, marker included.
if (input.tool_name === 'ExitPlanMode') process.exit(0);

// AskUserQuestion is not an authorization request — it is the agent ASKING, and the permission
// decision is where the ANSWER travels. `worker-autonomy` would allow it with `updatedInput` set to
// the untouched tool input, i.e. the questions and NO answers, and claude's own result mapper then
// tells the model "The user did not answer the questions." So the auto-approval that keeps a worker
// moving for every other tool is, for this one, a guaranteed wasted turn.
//
// Frizz's broker intercepts this call at canUseTool and renders it as a real question card the
// operator answers (claude-permission-interactions.ts), so the right move here is to say NOTHING —
// no decision AND no marker. A `defer` verdict would write a marker the tailer reads as a human
// permission block, stacking a second "needs you" surface on top of the card already asking.
// (Verified 2026-07-27 on a promoted artifact: workers dispatch at --permission-mode auto, so
// `restrictive-mode` does not catch this and `worker-autonomy` did allow it. A dev-stack harness at
// the default permission mode deferred and looked fine, which is exactly why this needed an
// artifact run to find.)
if (input.tool_name === 'AskUserQuestion') process.exit(0);

const verdict = evaluate(input);

// Record the decision BEFORE acting on it, best-effort. The marker is frizz's only structured view of
// what happened here: `decision` tells the tailer whether a human is actually blocked, and
// rule/reason/command are what the dashboard shows the human afterwards. A failed write must not
// hold up the worker, so this swallows its own errors — telemetry loss, not a stall.
const dir = process.env.FRIZZ_PERM_DIR;
if (dir) {
  try {
    const command = input.tool_name === 'Bash' ? String(input.tool_input?.command ?? '') : '';
    const marker = {
      slug,
      tool: typeof input.tool_name === 'string' ? input.tool_name : null,
      promptId: typeof input.prompt_id === 'string' ? input.prompt_id : null,
      permissionMode: typeof input.permission_mode === 'string' ? input.permission_mode : null,
      at: new Date().toISOString(),
      decision: verdict.decision,
      rule: verdict.rule,
      reason: verdict.reason,
      // Truncated: this is display text for the dashboard, not a re-executable command.
      ...(command ? { command: command.length > 300 ? `${command.slice(0, 300)}…` : command } : {}),
    };
    mkdirSync(dir, { recursive: true });
    // Write to a temp sibling then rename, so the tailer never reads a half-written marker.
    const dest = join(dir, `${slug}.json`);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(marker));
    renameSync(tmp, dest);
  } catch {
    // telemetry only — never block the worker on a marker write
  }
}

if (verdict.decision === 'allow') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: input.tool_input ?? {} },
      },
    }),
  );
} else if (verdict.decision === 'deny') {
  // On a PermissionRequest DENY the `decision` object carries ONLY `{behavior:"deny"}`; the reason the
  // model reads rides top-level `additionalContext` (same contract as deny-plan.mjs). Exit 0 with this
  // JSON on stdout — exit 2 would make Claude Code ignore the JSON, so never mix the two.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
      additionalContext: verdict.reason,
    }),
  );
}
// defer → emit nothing: the normal prompt is raised and the human answers it.
process.exit(0);
