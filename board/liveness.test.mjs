// @ts-check
/**
 * frizz — liveness derivation + binding tests. Run with: `node --test 'board/*.test.mjs'`.
 *
 * Covers the pure pieces the board (`index.mjs`) still joins:
 *   1. the NEWEST binding wins, never a superseded older agent;
 *   2. a thread whose PR is landing via the merge cascade (downstream) is suppressed;
 *   3. a TERMINATED/parked agent (rested + stale) is told from one mid-long-tool-call
 *      (stale but never rested → alive), and from a watcher-idle agent (generous threshold).
 * (The Stop hook's own join over these, `agent-liveness.mjs`, went with that hook: removed 2026-11-10.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAgentState, DEFAULT_DROPPED_MIN, DEFAULT_IDLE_MIN } from './agent-status.mjs';
import { newestBindingByThread, downstreamThreads, restedAgentIds, newBoundRestsSince } from './agent-bindings.mjs';

// ── deriveAgentState — the pure derivation ──────────────────────────────────────
test('deriveAgentState: terminal/parked/downstream all suppress', () => {
  const old = { ageMin: 999, hasRested: true };
  assert.equal(deriveAgentState({ ...old, threadTerminal: true, threadActive: true }), 'terminal');
  assert.equal(deriveAgentState({ ...old, threadTerminal: false, threadActive: false }), 'terminal', 'parked thread suppresses');
  assert.equal(deriveAgentState({ ...old, threadTerminal: false, threadActive: true, threadDownstream: true }), 'terminal', 'mid-merge thread suppresses');
});

test('deriveAgentState: dropped requires active + stale + rested', () => {
  const base = { threadTerminal: false, threadActive: true, threadDownstream: false };
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_DROPPED_MIN + 5, hasRested: true }), 'dropped');
  // stale but NEVER rested = still inside one long tool call (a build) → alive, not dropped.
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_DROPPED_MIN + 5, hasRested: false }), 'idle', 'stale + never-rested is a long tool call, never dropped');
});

test('deriveAgentState: idle band and fresh', () => {
  const base = { threadTerminal: false, threadActive: true, hasRested: true };
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_IDLE_MIN + 1 }), 'idle');
  assert.equal(deriveAgentState({ ...base, ageMin: DEFAULT_IDLE_MIN - 1 }), 'fresh');
  assert.equal(deriveAgentState({ ...base, ageMin: null }), 'unknown', 'no output file → unknown, never a flag');
});

test('deriveAgentState: frozenMin is honored as the back-compat alias for droppedMin', () => {
  const s = deriveAgentState({ ageMin: 30, threadTerminal: false, threadActive: true, hasRested: true, frozenMin: 25 });
  assert.equal(s, 'dropped', 'old callers passing frozenMin=25 still drive the dropped threshold');
});

// ── binding joins — fixture-backed ──────────────────────────────────────────────
/** Make a throwaway project dir with a `.frizz/`. */
function tmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'frizz-livetest-'));
  mkdirSync(join(dir, '.frizz'), { recursive: true });
  return dir;
}

test('newestBindingByThread: the newest binding wins, a superseded older agent is dropped', () => {
  const dir = tmpProject();
  try {
    const f = join(dir, '.frizz', '.agent-bindings.jsonl');
    writeFileSync(f,
      JSON.stringify({ ts: '2026-06-26T10:00:00.000Z', agent_id: 'OLD_dead_agent', thread: 'gvs', label: 'old' }) + '\n' +
      JSON.stringify({ ts: '2026-06-26T11:00:00.000Z', agent_id: 'NEW_live_agent', thread: 'gvs', label: 'new' }) + '\n');
    const newest = newestBindingByThread(dir);
    assert.equal(newest.get('gvs')?.id, 'NEW_live_agent', 'FP#1: must key on the newest binding, never the superseded one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downstreamThreads + restedAgentIds parse their logs (fail-open on missing)', () => {
  const dir = tmpProject();
  try {
    assert.equal(downstreamThreads(dir).size, 0, 'no merge-queue → empty, suppress nothing');
    assert.equal(restedAgentIds(dir).size, 0, 'no rest log → empty');
    writeFileSync(join(dir, '.frizz', 'merge-queue.jsonl'), JSON.stringify({ pr: 182, thread: 'shipping-thread' }) + '\n');
    writeFileSync(join(dir, '.frizz', '.rested-agents.jsonl'), JSON.stringify({ agent_id: 'A1', thread: 't' }) + '\nbad json\n');
    assert.ok(downstreamThreads(dir).has('shipping-thread'));
    assert.ok(restedAgentIds(dir).has('A1'), 'parses valid lines, skips malformed ones');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('newBoundRestsSince: a nested/unbound sub-agent rest does NOT nag; a bound rest DOES', () => {
  const dir = tmpProject();
  try {
    // The orchestrator dispatched ONE thread-owning agent → it is bound. A worker the
    // orchestrator dispatched then spawned its OWN self-review sub-agent (no THREAD tag →
    // no binding → unbound), which also rested. Plus an anon (no-id) rest.
    writeFileSync(join(dir, '.frizz', '.agent-bindings.jsonl'),
      JSON.stringify({ ts: '2026-06-26T10:00:00.000Z', agent_id: 'BOUND', thread: 'mythread', label: 'L' }) + '\n');
    writeFileSync(join(dir, '.frizz', '.rested-agents.jsonl'),
      JSON.stringify({ ts: '2026-06-26T11:00:00.000Z', agent_id: 'BOUND', thread: 'mythread' }) + '\n' +
      JSON.stringify({ ts: '2026-06-26T11:05:00.000Z', agent_id: 'NESTED_unbound', thread: null }) + '\n' +
      JSON.stringify({ ts: '2026-06-26T11:06:00.000Z', agent_id: null, thread: null }) + '\n');

    const r = newBoundRestsSince(dir, 0, []);
    assert.equal(r.count, 1, 'only the thread-bound rest counts — nested + anon are excluded');
    assert.deepEqual(r.agents, ['BOUND'], 'the bound agent is the sole nag target');
    assert.deepEqual(r.threads, ['mythread'], 'its thread is named for the reconcile pointer');

    // Loop-safety: once surfaced, the bound agent's repeat rest does not re-nag.
    assert.equal(newBoundRestsSince(dir, 0, ['BOUND']).count, 0, 'seen-set dedupes a resuming bound agent');
    // sinceMs gates: a bound rest at-or-before the watermark does not re-count.
    assert.equal(newBoundRestsSince(dir, Date.parse('2026-06-26T11:00:00.000Z'), []).count, 0, 'rest not newer than the watermark is excluded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
