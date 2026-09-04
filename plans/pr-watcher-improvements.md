# The registered PR watcher: what it missed on 2026-09-04, and what to change

Status: ASSESSMENT + PROPOSALS. Written 2026-09-04 after the maintainer reported that the watcher on thread `clone-node-and-find-the-least` (project `nub`) had let reviews and CI failures pass without notifying the worker. Nothing here is built. Every figure below was read off this machine's own `~/.frizz/ui.db`, the thread's transcript, and GitHub's API for the two PRs involved.

The headline: the watcher's polling is fine — it caught a CI failure 48s after the job went red. The defects are in **when the news is allowed to reach the worker**, in **what counts as a verdict**, and in **what the watcher is blind to**. Two of the three reports it did send on the day were factually wrong, and the one that mattered arrived 10m late.

---

## 1. The trace

Two PRs against `nodejs/node`, both opened by the worker at 15:15Z on 2026-09-04, both registered with `mcp__frizz__watch_pr` for 180d:

- [#65795](https://github.com/nodejs/node/pull/65795) — watcher `prw_2033cc5165df`
- [#65796](https://github.com/nodejs/node/pull/65796) — watcher `prw_66da4f676f55`

| time (UTC) | what happened | what the watcher did |
| --- | --- | --- |
| 15:12:32 | both watchers registered | — |
| 15:13:34 | — | minted report 1 for #65795: **"✅ CI PASSED — 15 checks green"** |
| 15:14:34 | — | minted report 1 for #65796: **"✅ CI PASSED — 11 checks green"** |
| 15:15:38 | worker rested | both reports delivered, batched |
| 15:18:10 | **both PRs force-pushed**; every check voided, real CI starts | nothing |
| 15:33–15:40 | #65796's lint suite goes green on the new head | nothing (correct: not terminal) |
| 15:38:45 | **panva submits a review on #65796** (3 inline comments) | report 2 minted 15:38:59, delivered 15:39:01 — **16s** |
| 15:48:18 | #65796 labeled `crypto` | nothing |
| 15:39–now | #65795's real 29-check matrix runs on the new head | nothing, for 1h 40m and counting |
| 16:43:19 | **`x86_64-darwin: with shared libraries / build` FAILS on #65796** | detected 16:44:07 — **48s** |
| 16:44:07 → 16:54:11 | worker is mid-turn | report 3 **held for 10m 04s** |
| 16:54:11.371 | — | report 3 finally released into the runtime's queue |
| 16:54:11.582 | **the maintainer types "There are already reviews. Why don't you incorporate them?"** | — |

The maintainer's message and Frizz's own wake landed in the same queue drain, 211ms apart. He had been looking at a PR page showing a red build and an unanswered review while the thread worked on something else, with no way to tell whether the watcher was alive.

---

## 2. The defects

### D1 — PR news waits up to 10m behind a busy turn

`MID_TURN_HOLD_MAX_MS = 10 * 60_000` ([`scheduler.ts:1033`](../packages/server/src/scheduler.ts)), and `isDeliverableNow` ([`scheduler.ts:1285`](../packages/server/src/scheduler.ts)) exempts exactly three fence kinds from the hold: the recurring prompt's schedule trigger, a one-off timer, and the post-compaction prompt. A PR-watch report is not among them, so it waits for the thread to rest — or for the 10m ceiling, whichever comes first.

Measured: the darwin build failed at 16:43:19Z, the poll saw it at 16:44:07Z, and the report went out at 16:54:11Z. The entire 10m 04s is the hold. The thread had been in one turn since 16:32:46 and stayed in it until 16:57.

The comment defending the hold says delivering mid-turn "would interrupt work the worker is already doing about the very thing that woke it." That reasoning is sound for a park bump or an elapsed fence — the thread is being told about its own state. It does not hold for a CI failure or a reviewer's change request: that is news from outside, which the worker cannot already be acting on, and it is the same class of event as a background shell finishing — which the runtime *does* deliver mid-turn, immediately.

The asymmetry is stark. A shell the worker started reaches it in seconds. A build the worker pushed reaches it in ten minutes.

### D2 — The first report on a fresh PR is a false green

`githubWatchStatus` ([`scheduler.ts:226`](../packages/server/src/scheduler.ts)) reduces the rollup to `entries.length === 0 ? "none" : failed > 0 ? "failing" : running > 0 ? "running" : "passing"`. Every terminal entry that did not fail counts as passed — including `skipped`.

At 15:13:03Z, #65795's head `d52830ae` had exactly 15 check runs, and every one of them was GitHub-App plumbing:

```
success  label                          skipped  notable-change  (x3)
success  Resolve contributor status     skipped  fast-track      (x3)
success  Apply contributor guidance     skipped  stale-comment   (x3)
                                        skipped  Notify on Review Wanted (x3)
```

Not one build. Not one test. Node's real CI — 29 checks across eight platforms — never ran on that commit at all; it started at 15:39Z on the next head. Frizz's first word to the worker was **"✅ CI PASSED on nodejs/node#65795 — 15 checks green."**

#65796 got the same treatment with 11 checks. Both reports were wrong, both burned a wake, and both left a worker holding a green verdict for a commit that was never built.

This is not a nodejs/node quirk. Any repo whose workflows are gated on a label, a fork-approval, or a path filter produces a plumbing-only rollup in the first minute after a PR opens.

### D3 — A new head is not news, and it silently voids the last verdict

The trigger set is: the PR closing or merging, the terminal CI verdict changing, and new review or comment activity. A push is not in it.

Both PRs were force-pushed at 15:18:10Z. #65796's rollup was replaced wholesale — 34 fresh check runs. From 15:18 to 16:43, 85m, the watcher said nothing about CI, because nothing was terminal. That is correct by the current rules and useless in practice: a worker resting on report 1's "CI PASSED" had no way to learn the verdict had been voided.

The head is already carried in the CI stamp (`<head>:<verdict>:<failing jobs>`), so the watcher *knows* the head moved. It just has nothing to say about it.

### D4 — "Running" is indistinguishable from "broken"

`running` is deliberately not news, and on a small repo that is right — the verdict lands in a couple of minutes. On nodejs/node the matrix takes about 1h 30m. #65795 has been running since 15:39Z with no report, and the next one is due whenever all 29 checks settle.

For 1h 40m, a worker resting on that watcher and a maintainer reading the board see the same thing from Frizz: silence. There is no reading that separates "CI is grinding, 15 of 29 done" from "the watcher is dead." That ambiguity *is* the complaint.

The board can already draw the distinction — `AwaitingBackgroundCard` renders "1 failing · 2 in progress · 31 successful" plus the merge verdict, off a status book the poller publishes for every watched PR ([`scheduler.ts:1072`](../packages/server/src/scheduler.ts)). But that card is drawn for a thread that is **parked**. This thread was spinning, so the maintainer saw none of it.

### D5 — "CI FAILED: <job name>" costs the worker four tool calls

The report read, in full: `❌ CI FAILED on nodejs/node#65796: x86_64-darwin: with shared libraries / build.`

What the worker did next, from the transcript: `gh api …/pulls/65796/reviews`, then `gh run view 33888697242 --json …` (55.6 KB, large enough that the harness spilled it to a file), then two `grep` passes over that file to locate the failing step. About 1m of wall clock and a large context hit to answer "why did it fail", which Frizz was one API call away from answering when it minted the wake.

### D6 — The watcher is blind to most of a PR's state machine

Not watched, and not reported: labels, `mergeable: CONFLICTING`, review requests, ready-for-review, merge-queue entry or eject, a dismissed approval.

Labels are not cosmetic on nodejs/node — `needs-ci`, `commit-queue-failed`, `author ready` and `blocked` are how the project's automation communicates. #65796 was labeled `crypto` at 15:48:18Z and had two review requests; none of it reached the worker.

The conflict case is the sharpest: `githubWatchStatus` already computes `merge: "conflicting" | "blocked" | "mergeable" | "unknown"` from data it already fetched, and then nothing uses it as a trigger. A PR that develops a merge conflict is silent until something else happens to it.

### D7 — Two network round-trips per PR per poll

`fetchPr` shells out to `gh pr view` once per PR; `fetchGithubReview` runs a batched GraphQL query covering up to 20 refs. With 7 armed watchers on this machine that is ~8 status subprocesses and 1 GraphQL call per minute. It works, but it is the ceiling on both a faster poll and the extra timeline items D3 and D6 need.

---

## 3. Proposals

Ranked by what they would have changed on 2026-09-04.

### P1 — Deliver PR news mid-turn (fixes D1)

Add the PR-watch fence prefix to the `isDeliverableNow` exemption beside the heartbeat, the timer and the compaction prompt. Both transports already take a mid-turn message natively and neither aborts the running turn, so this is a gate change, not a new channel.

The flood risk is already handled upstream: the one-undelivered-report-per-watcher rule plus the 2026-09-03 re-mint fold guarantee at most one queued message per watcher, carrying everything since the last one the worker read. A chatty PR produces one message, not eleven.

**Variant, if a blanket exemption feels too loud:** exempt only the high-salience reports — CI failing, changes requested, merged, closed, conflicting — and let a routine comment or a green verdict keep waiting for rest. This is more code and one more thing to keep in step, and I would only reach for it if the blanket version proves noisy in practice.

### P2 — A plumbing-only rollup is not a pass (fixes D2)

Two parts, both small:

1. **`skipped` and `neutral` stop counting as green.** They are terminal and not failures, so they must not make the rollup pending — but a rollup whose *only* successes are skips has nothing to report. Concretely: `passing` requires at least one entry that concluded `SUCCESS`.
2. **A rollup that has not finished being created is `running`, not terminal.** GitHub exposes `checkSuites` with their own `status`; a suite still `QUEUED` or `REQUESTED` means more runs are coming. Reading that is the principled fix. The cheap approximation — never mint the first terminal verdict for a head younger than ~3m — would also have caught both of the day's false greens, since Node's real workflows registered at 15:33Z, 21m after the head appeared.

Whichever lands, the message should print the breakdown rather than one number: "3 green, 12 skipped" is self-evidently not a passing CI run, where "15 checks green" reads as one.

### P3 — Report a new head (fixes D3)

The head is already in the stamp. When it changes, say so once: `🔄 nodejs/node#65796 has a new head 043813be — the previous CI verdict no longer applies; N checks starting.` One line, no new fetch, and it converts the 85m silence into a fact the worker can act on.

For a PR the worker pushed itself this is a no-op it can ignore. For a PR it is reviewing, or one a maintainer rebased under it, it is the most consequential event the watcher can observe — and today it cannot say it at all.

### P4 — End the long silence, on both surfaces (fixes D4)

Two independent halves, and the second is cheaper and helps the human directly:

- **For the worker:** a decaying progress report on a long-running matrix — at +15m, +45m, then hourly — carrying the counts and nothing else. Or a threshold report ("all builds green, tests running"), which is less chatty and more useful. Worth making this per-watcher opt-in if it proves noisy.
- **For the maintainer:** render the check readout on the **Active** row too, not only on the parked awaiting card. The status book is already published for every watched PR and the renderer already exists; today a spinning thread hides it. Had the board shown "1 failing · 2 in progress · 31 successful" beside #65796 at 16:44, the question that started this effort would not have needed asking.

### P5 — Carry the failure, not just the job name (fixes D5)

When the verdict turns red, fetch the failed job's failing step and the last ~40 lines of its log, and inline them under a cap. Frizz already has the run id. This is the single biggest per-wake saving in the list — it removes three or four tool calls and a 55 KB log spill from the worker's first move after every red build.

### P6 — Widen the event set (fixes D6)

Fold in, in this order:

1. **`merge` transitions** — the data is already fetched and already reduced; `mergeable` going to `conflicting`, and `blocked` clearing, are one comparison each.
2. **Labels** — a curated allowlist per repo would be over-engineering; reporting every label add/remove would be noise. A reasonable middle: report label changes only when the PR is otherwise quiet, or match against a small default list of state-machine names.
3. **Review requests / ready-for-review / merge-queue events** — one timeline query, which P7 makes affordable.

### P7 — One fetch per poll (fixes D7)

Fold the status fields into the same batched GraphQL query the review fetcher already runs, so a poll is one request for up to 20 PRs instead of one subprocess each plus a query. That buys the headroom for the timeline items P3 and P6 want, and for a faster poll if we ever want one.

### P8 — Say what the watcher does and does not cover

The registration return should state the contract plainly: it reports a terminal CI verdict change, new review or comment activity, and merge/close — and (until P3/P6 land) it does *not* report a new head, a running matrix, a label, or a conflict. A worker that rests believing it is covered for something it is not is the exact stall the whole grammar exists to prevent.

---

## 4. What I would build first

**P1, P2 and P5, in that order.** P1 is the maintainer's actual complaint and a one-line gate change. P2 is the watcher stating something false, which is worse than stating nothing. P5 is the biggest saving per red build, and it is self-contained.

P3 is a close fourth and very cheap — it may well be worth folding into the same change as P2, since both are about the head no longer meaning what the worker thinks it means.

P4's board half is a small, isolated UI change and can go in parallel with any of them.
