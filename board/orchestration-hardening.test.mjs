// @ts-check
/**
 * frizz — orchestration-hardening tests (2026-07-06). Run: `node --test 'board/*.test.mjs'`.
 *
 * Covers the anti-treadmill / anti-drop PREDICATES the board exports. (The orchestrator hooks that
 * consumed them — frizz-stop-reminder, frizz-subagent-rest — retired with the plugin; only the pure
 * functions survive, so only those are tested here.)
 *   #1 OWNER-CLEAN — an owning-agent thread edit is owner-clean, NOT drift (ownerCleanMtime /
 *      assessDrift / computeBoardDrift).
 *   #2 SCOPED STALENESS — reconcileStampLastInstruction names the drifted thread(s).
 *   #3 STRUCTURED queued detection — only an UNCHECKED `- [ ]` follow-up flags (hasQueuedFollowup).
 *   #4 DEBOUNCE — a `dirty` nag holds until it persists > T min AND > K turns (debounceReconcileNag).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerCleanMtime,
  assessDrift,
  computeBoardDrift,
  hasQueuedFollowup,
  debounceReconcileNag,
  reconcileStampLastInstruction,
  DEFAULT_RECONCILE_DEBOUNCE_MIN,
  DEFAULT_RECONCILE_DEBOUNCE_TURNS,
} from './config.mjs';

const BACKSTOP = 120;

/** A throwaway ACTIVATED `.frizz/` project (session sentinel ON). */

// ── #1 owner-clean predicate + owner-filtered drift ─────────────────────────────────
test('ownerCleanMtime: a mark ≥ current mtime is clean; no mark / stale mark is not', () => {
  assert.equal(ownerCleanMtime(1000, 1000), true, 'exactly at the mark → owning-agent edit → clean');
  assert.equal(ownerCleanMtime(999, 1000), true, 'below the mark → clean');
  assert.equal(ownerCleanMtime(1001, 1000), false, 'edited AFTER the owner mark → non-owning drift');
  assert.equal(ownerCleanMtime(1000, undefined), false, 'no mark → not clean (never suppress an unmarked thread)');
  assert.equal(ownerCleanMtime(0, 1000), false, 'unreadable mtime (0) → not clean');
});

test('assessDrift: an owning-agent edit is excluded; a non-owning edit is dirty + named', () => {
  const last = 1_000_000;
  const records = [
    { slug: 'owned', status: 'active', mtimeMs: last + 5000 }, // edited after reconcile, BUT owner-clean
    { slug: 'drifted', status: 'active', mtimeMs: last + 9000 }, // edited after reconcile, no owner mark
    { slug: 'done-x', status: 'done', mtimeMs: last + 9999 }, // terminal → never counts
  ];
  const owner = { owned: last + 5000 };
  const d = assessDrift({ records, ownerReconciled: owner, lastReconcileMs: last, backstopMin: BACKSTOP, now: last + 10_000 });
  assert.equal(d.nag, true, 'the non-owning edit trips the dirty-gate');
  assert.equal(d.reason, 'dirty');
  assert.deepEqual(d.dirtySlugs, ['drifted'], 'ONLY the non-owning thread is named — the write-ownership edit is excluded');
});

test('assessDrift: a board whose only change is owning-agent edits is CLEAN (no treadmill)', () => {
  const last = 1_000_000;
  const records = [{ slug: 'owned', status: 'active', mtimeMs: last + 5000 }];
  const d = assessDrift({ records, ownerReconciled: { owned: last + 5000 }, lastReconcileMs: last, backstopMin: BACKSTOP, now: last + 6000 });
  assert.equal(d.nag, false, 'an agent editing its OWN thread does not nag a board re-ground');
  assert.deepEqual(d.dirtySlugs, []);
});

// ── #1 write side: the SubagentStop hook stamps owner-reconciled ─────────────────────

// ── #3 scoped staleness instruction ─────────────────────────────────────────────────
test('reconcileStampLastInstruction: scoped names the threads; unscoped says every non-terminal', () => {
  const scoped = reconcileStampLastInstruction(['alpha', 'beta']);
  assert.match(scoped, /re-ground alpha, beta/, 'the specific drifted threads are named');
  assert.doesNotMatch(scoped, /re-ground EVERY non-terminal/, 'scoped does NOT say "every non-terminal thread"');
  assert.match(reconcileStampLastInstruction(), /re-ground EVERY non-terminal thread/, 'unscoped = full sweep (backstop/first case)');
  assert.match(reconcileStampLastInstruction([]), /re-ground EVERY non-terminal thread/, 'empty scope = full sweep');
});

// ── #4 structured queued-followup detection ─────────────────────────────────────────
test('hasQueuedFollowup: only an UNCHECKED `- [ ]` follow-up flags; checked / prose never do', () => {
  assert.equal(hasQueuedFollowup('- [ ] QUEUED: dispatch review on AG1 return'), true, 'unchecked QUEUED item flags');
  assert.equal(hasQueuedFollowup('- [ ] dispatch the self-review on its return'), true, 'unchecked "dispatch … return" flags');
  assert.equal(hasQueuedFollowup('- [x] QUEUED: dispatch review on AG1 return'), false, 'a CHECKED-OFF item never flags (the false-positive killed)');
  assert.equal(hasQueuedFollowup('We already QUEUED and drained the follow-up.'), false, 'a prose mention of QUEUED never flags');
  assert.equal(hasQueuedFollowup('- [ ] land the PR'), false, 'an unchecked item without the follow-up shape does not flag');
  assert.equal(hasQueuedFollowup('title: t\nstatus: active\n'), false, 'no checkbox → no flag');
});

// ── #5 debounce ─────────────────────────────────────────────────────────────────────
test('debounceReconcileNag: dirty holds for T min AND K turns; first/backstop nag at once; clean resets', () => {
  const min = DEFAULT_RECONCILE_DEBOUNCE_MIN, turns = DEFAULT_RECONCILE_DEBOUNCE_TURNS, now = 5_000_000;
  // clean → no nag, window cleared
  assert.deepEqual(debounceReconcileNag({ reason: null, now, turns: 9, state: { dirty_since_ms: 1, dirty_since_turn: 1 }, debounceMin: min, debounceTurns: turns }), { nag: false, state: {} });
  // first + backstop → immediate, no window
  assert.equal(debounceReconcileNag({ reason: 'first', now, turns: 1, state: {}, debounceMin: min, debounceTurns: turns }).nag, true);
  assert.equal(debounceReconcileNag({ reason: 'backstop', now, turns: 1, state: {}, debounceMin: min, debounceTurns: turns }).nag, true);
  // dirty, first sighting → silent, starts the window
  const first = debounceReconcileNag({ reason: 'dirty', now, turns: 3, state: {}, debounceMin: min, debounceTurns: turns });
  assert.equal(first.nag, false, 'dirty first-sight is debounced');
  assert.deepEqual(first.state, { dirty_since_ms: now, dirty_since_turn: 3 });
  // dirty, aged in turns but NOT in time → still silent (AND, not OR)
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + 60_000, turns: 3 + turns, state: first.state, debounceMin: min, debounceTurns: turns }).nag, false, 'enough turns but < T minutes → still held');
  // dirty, aged in time but NOT in turns → still silent
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + (min + 1) * 60_000, turns: 3 + 1, state: first.state, debounceMin: min, debounceTurns: turns }).nag, false, 'enough time but < K turns → still held');
  // dirty, aged past BOTH → nag
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + (min + 1) * 60_000, turns: 3 + turns, state: first.state, debounceMin: min, debounceTurns: turns }).nag, true, 'past both thresholds → fires');
});
