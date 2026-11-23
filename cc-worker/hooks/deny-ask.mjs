#!/usr/bin/env node
// @ts-check
// PreToolUse hook on AskUserQuestion (frizz-worker). A frizz worker runs under a dashboard, not a
// live chat: an interactive question prompt would hang the session invisibly (nobody is at the
// keyboard to click it). Deny with a redirect to the async pattern: ask it in a structured ```question
// fence in the worker's own message (a row, registered when the message lands — since 2026-10-13; it
// was `frizzctl ask` before that), keep working, and rest normally; the answer arrives as its own wake.
// GATE: inert unless FRIZZ_THREAD is set. FAIL OPEN on parse errors.
//
// SECOND GATE: also inert when FRIZZ_NATIVE_ASK=1. The premise above — "nobody is at the keyboard" —
// is only true where the question has nowhere to go. On the Claude session-broker path frizz now
// intercepts the call at canUseTool and renders it as a real question card on the dashboard, which the
// operator answers and which returns the chosen labels to the tool. The broker bridge sets that var
// only when an InteractionStore is actually wired to render and resolve the card, so a denial here
// would block a question the operator CAN see. Any other path leaves the var unset, so it keeps the
// deny plus the ```question fence redirect.
import { readFileSync } from 'node:fs';

const slug = process.env.FRIZZ_THREAD;
if (!slug) process.exit(0);
if (process.env.FRIZZ_NATIVE_ASK === '1') process.exit(0);

try {
  JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // fail open — a broken hook must never halt work
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Interactive prompts freeze headless workers (no one is at the keyboard to answer). Ask it in a ```question fence in your own message instead: `id:` (a slug of your choosing), `kind:` (`choice`, `multi`, `text` or `secret`), a one-line `question:`, and `options:` as `- label:` items with a one-line `description:` each in sentence case, the recommended one first with `recommended: true`; context for the human goes below a `---` line, in any Markdown. One fence per question, each self-contained, written actor-explicit — never "I" or "you", which flip meaning when the human clicks an option. Frizz registers it when your message lands and draws its card where you wrote it (`frizzctl ask --help` shows the whole grammar). Asking does not end your turn — keep doing what does not depend on the answer, then rest normally: the question IS the handback (no done fence beside it, and do NOT invoke this tool again). The answer arrives as your next user message.',
    },
  }),
);
process.exit(0);
