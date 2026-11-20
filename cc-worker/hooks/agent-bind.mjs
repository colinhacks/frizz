#!/usr/bin/env node
// @ts-check
// PostToolUse hook on the `Agent` tool (frizz-worker) — the AUTOMATIC thread↔agent binding, kept
// COMPATIBLE with cc's board. When a worker dispatches a helper tagged `THREAD: <slug>` at the top
// of the prompt, this records `agentId → thread` into `.frizz/.agent-bindings.jsonl` in the exact
// shape cc's board (`bindingsByThread`) reads for per-thread sub-agent liveness — so frizz renders
// a worker's helper activity the same way the cc board does. An untagged helper writes nothing.
//
// GATE: inert unless FRIZZ_THREAD is set. FAIL-OPEN ABSOLUTELY: any error → exit 0, no output.
// A missed binding just means one helper isn't surfaced; a PostToolUse hook must never disturb the turn.
import { readFileSync } from 'node:fs';
import { recordBinding, threadFromPrompt } from '../scripts/frizz/agent-bindings.mjs';
import { isHomeDirectory } from '../lib/project-frizz-dir.mjs';

try {
  // WORKER GATE.
  if (!(process.env.FRIZZ_THREAD ?? '').trim()) process.exit(0);

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';

  const ti = input.tool_input ?? {};
  const tr = input.tool_response ?? {};
  const trInner = tr.toolUseResult ?? tr;

  const agentId = trInner.agentId ?? tr.agentId ?? null;
  const prompt =
    (typeof trInner.prompt === 'string' && trInner.prompt) ||
    (typeof tr.prompt === 'string' && tr.prompt) ||
    (typeof ti.prompt === 'string' && ti.prompt) ||
    '';
  const thread = threadFromPrompt(prompt);
  const label = (typeof ti.description === 'string' && ti.description) || trInner.description || null;

  // Not in the home project, whose `.frizz` would be Frizz's own legacy state root (lib/project-frizz-dir.mjs).
  if (agentId && thread && !isHomeDirectory(dir)) {
    recordBinding(dir, { agentId, thread, label, session: input.session_id ?? null });
  }
} catch {
  /* fail-open — never disturb the turn */
}
process.exit(0);
