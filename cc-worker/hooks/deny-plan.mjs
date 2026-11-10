#!/usr/bin/env node
// @ts-check
// PermissionRequest hook on ExitPlanMode (frizz) — a frizz worker runs under a dashboard, not a
// live chat, so the plan-APPROVAL prompt (shown when the model calls ExitPlanMode to present a plan
// and ask to proceed) would hang the session invisibly. Deny it and redirect the worker: proceed if
// the plan is settled, write it to a durable plan file if the plan is the deliverable, and ask in a
// ```question fence if it needs a human call first (the `reason` below, word for word).
//
// WHY PermissionRequest, not PreToolUse: ExitPlanMode is a PERMISSION surface, not a plain tool —
// it is denied via PermissionRequest (AskUserQuestion, a real tool, is denied via PreToolUse in the
// sibling deny-ask.mjs). CAVEAT: PermissionRequest hooks do NOT fire under `claude -p` (headless
// print mode); a frizz worker runs as an INTERACTIVE `claude` session inside its session-broker
// daemon, where they DO fire. So this protects the real worker path; the `-p` smoke test cannot
// exercise it (documented).
//
// PLAN-MODE SOFTLOCK — why this denies UNCONDITIONALLY when gated: a session genuinely IN plan mode
// is read-only until ExitPlanMode is approved, so denying ExitPlanMode there would SOFTLOCK it
// (can't exit → can't edit → can't even follow the redirect and write the plan file). This hook does not
// branch on the session's mode. (An earlier note here claimed the PermissionRequest input carries no
// permission-mode signal — that is FALSE and was corrected 2026-07-25: the payload carries
// `permission_mode`, `tool_name`, and `tool_input`, which is exactly what the sibling perm-policy.mjs
// keys its rules on. The unconditional deny is kept because the SOURCE fix below makes plan mode
// unreachable for a frizz worker anyway, not because the signal is unavailable.) The fix is at the SOURCE
// instead — frizz NEVER spawns a worker in plan mode (dispatch.ts coerces `--permission-mode plan`
// → `auto` in both command builders), so a real frizz worker is never in plan mode and this deny
// only ever meets a SPURIOUS ExitPlanMode call (nothing to exit → deny + redirect is correct). A
// worker "plans" by writing a durable plan file and asking in a ```question fence,
// never via interactive plan mode.
// RESIDUAL GAP (accepted, documented): the deny could softlock only a FOREIGN session that is
// simultaneously in plan mode AND running with FRIZZ_THREAD set AND this plugin loaded — a combo
// frizz never produces (FRIZZ_THREAD is set only by frizz dispatch, which coerces plan away).
// A normal plan-mode session outside frizz is untouched (this hook is inert without FRIZZ_THREAD).
//
// GATE: inert unless FRIZZ_THREAD is set. FAIL OPEN on any parse error — a broken hook must never
// halt work.
import { readFileSync } from 'node:fs';

const slug = process.env.FRIZZ_THREAD;
if (!slug) process.exit(0);

try {
  JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // fail open — a broken hook must never halt work
}

// The instructive redirect rides TOP-LEVEL `additionalContext` (per the Claude Code hooks docs) —
// on a PermissionRequest DENY the `decision` object carries ONLY `{behavior:"deny"}`; the reason
// the model reads is `additionalContext`, injected as a plain-text system-reminder. Exit 0 with
// this JSON on stdout (exit 2 would make Claude Code ignore the JSON — never mix).
const reason =
  'Interactive plan-approval prompts freeze headless workers (no one is at the keyboard to approve). Do NOT present a plan for approval. Instead: if the plan is settled, just proceed with the work. If the plan is the deliverable, write it into a durable plan file — wherever the dispatch or the project\'s conventions name; your scratch directory works when nothing names one. If it needs a human call before you build, ask a two-option `kind: choice` question in a ```question fence stating what you need approved, then come to rest — the human reviews it from the frizz queue.';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny' },
    },
    additionalContext: reason,
  }),
);
process.exit(0);
