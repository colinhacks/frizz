// A WATCHED PR'S CHECKS — the projection, and the queue rule it decides.
//
// A pr-watch thread is normally a VISIBLE queue handoff, deliberately: a PR whose reviews may never
// arrive must not silently vanish (2026-07-22). CI is the exception because it has a KNOWN TERMINAL
// CONDITION — the checks finish and the thread comes straight back — so hiding the card while they run
// cannot lose anything (maintainer 2026-08-14: "if there is a GitHub watcher registered and the GitHub
// actions are still running, then that should remain in the running active rail. Only if CI has failed
// or completed successfully should it show up back in the queue").
//
// What these pin is that the hold is NARROW: only a live `running` reading on every watched PR holds a
// thread out of the queue. Not-knowing, no-CI, done, failed, merged and closed all queue.
import { test } from "node:test"
import assert from "node:assert/strict"
import { githubWatchStatus, type PrStatus } from "./scheduler.ts"
import { readGithubStatusBook } from "./awaiting.ts"
import { parseGithubPrSnapshot } from "./github-review.ts"
import { deriveNeedsYou, deriveAwaitingBackground, fenceWatchViews } from "./board.ts"
import type { SessionTelemetry } from "./tailer.ts"
import type { SessionRow } from "./storage.ts"

const AT = "2026-08-14T00:00:00.000Z"
const LATER = "2026-08-14T00:10:00.000Z"
const NOW = Date.parse(LATER) + 1000
const REF = "acme/app#391"
// A `pr-watch:` line DECLARES a wait; `mcp__frizz__watch_pr` CREATES one. The board honours a declaration
// only when a registered watcher stands behind it — otherwise the thread is claiming a wait nothing will
// ever deliver. Every case here therefore carries the registered set explicitly.
const REGISTERED = new Set([REF])
/** The same watchers as rows, for `fenceWatchViews` — which lists the REGISTRY, not the fence. */
const REGISTERED_ROWS = [{ target: REF, createdAt: LATER }]

const check = (over: Record<string, unknown>) => over
const pr = (over: Partial<PrStatus> = {}): PrStatus =>
  ({ state: "OPEN", mergedAt: null, rollup: [], ...over }) as PrStatus

// ---- the projection ----

test("an empty rollup is `none`, not `running` — a PR with no CI must not wait for checks that never come", () => {
  const s = githubWatchStatus(pr(), AT)
  assert.equal(s.checks, "none")
  assert.deepEqual([s.running, s.passed, s.failed], [0, 0, 0])
})

test("the verdict and the counts read the rollup the way `evalRollup` does", () => {
  const s = githubWatchStatus(pr({
    rollup: [
      check({ status: "COMPLETED", conclusion: "SUCCESS", name: "build" }),
      check({ status: "IN_PROGRESS", name: "test" }),
      check({ state: "SUCCESS", context: "codecov" }),
    ],
  }), AT)
  assert.equal(s.checks, "running", "anything unfinished and nothing red reads as running")
  assert.deepEqual([s.running, s.passed, s.failed], [1, 2, 0])
})

// ---- what "passing" is allowed to mean (2026-09-04) ----
//
// THE REGRESSION THESE PIN, in the shape it actually arrived in. nodejs/node#65795 was opened at
// 2026-09-04T15:12Z and frizz's first report, 62s later, read "✅ CI PASSED — 15 checks green". The
// commit was never built: Node's real 29-check matrix was held at GitHub's fork-approval gate and the
// 15 entries in the rollup were 12 `SKIPPED` no-ops plus 3 label bots. Both halves had to be wrong at
// once for the sentence to be composed, so both are pinned separately below and then together.

test("a workflow held for approval is not a pass — it is CI that has not started", () => {
  const s = githubWatchStatus(pr({
    rollup: [check({ status: "COMPLETED", conclusion: "SUCCESS", name: "label" })],
    workflowRuns: [
      { workflowName: "Test Linux", status: "completed", conclusion: "ACTION_REQUIRED" },
      { workflowName: "Test macOS", status: "completed", conclusion: "ACTION_REQUIRED" },
      { workflowName: "Test Linux", status: "completed", conclusion: "ACTION_REQUIRED" }, // a re-queued gate, one workflow
    ],
  }), AT)
  assert.equal(s.checks, "running", "gated CI has not settled, so the thread stays parked exactly as it does mid-run")
  assert.equal(s.gated, 2, "the same workflow held twice is one workflow")
  assert.deepEqual(s.gating, ["Test Linux", "Test macOS"], "named, because a count does not say what is being withheld")
  assert.deepEqual(s.failing, [], "a pending approval is not a failure and must never be listed as one")
})

// THE `gh` FALLBACK'S CASING (2026-09-11). `gh run list --json conclusion` prints the REST shape —
// `action_required`, `failure` — where the batched GraphQL poll concludes `ACTION_REQUIRED`. The readers
// compared the raw string against the upper-case word, so a poll served by the fallback saw no gate and
// no failed run at all. Below is the exact `gh run list` output for microsoft/TypeScript#64248 at head
// 15bb626 beside its exact one-entry rollup: the reading that went out as "✅ CI PASSED — 1 check green"
// on every tick the GraphQL batch failed, and flipped back to gated on the tick after.
test("the `gh run list` fallback's lower-case conclusions read as the same gate, not as a pass", () => {
  const s = githubWatchStatus(pr({
    rollup: [check({ status: "COMPLETED", conclusion: "SUCCESS", name: "license/cla" })],
    workflowRuns: [
      { conclusion: "action_required", event: "pull_request", name: "CI", status: "completed", workflowName: "CI" },
      { conclusion: "action_required", event: "pull_request", name: "CodeQL", status: "completed", workflowName: "CodeQL" },
    ],
  }), AT)
  assert.equal(s.checks, "running", "the gate is visible through the fallback exactly as through the batched poll")
  assert.deepEqual([s.gated, s.gating, s.passed], [2, ["CI", "CodeQL"], 1])
})

test("the `gh run list` fallback's lower-case failures are NAMED, as the batched poll's are", () => {
  const s = githubWatchStatus(pr({
    rollup: [check({ status: "COMPLETED", conclusion: "FAILURE", name: "lint" })],
    workflowRuns: [
      { conclusion: "failure", event: "pull_request", name: "CI", status: "completed", workflowName: "CI" },
      { conclusion: "action_required", event: "pull_request", name: "CodeQL", status: "completed", workflowName: "CodeQL" },
    ],
  }), AT)
  assert.equal(s.checks, "failing")
  assert.deepEqual(s.failing, ["lint", "CI"], "the red run is named; the gated one is not a failure in either casing")
})

test("a rollup that only skipped has run nothing, so it is `none` rather than green", () => {
  const s = githubWatchStatus(pr({
    rollup: [
      check({ status: "COMPLETED", conclusion: "SKIPPED", name: "notable-change" }),
      check({ status: "COMPLETED", conclusion: "STALE", name: "fast-track" }),
    ],
  }), AT)
  assert.equal(s.checks, "none")
  assert.deepEqual([s.passed, s.skipped], [0, 2], "a skip is terminal and not a failure, and it is not a pass either")
})

test("skips are counted apart from passes, so a green tally cannot be padded with them", () => {
  const s = githubWatchStatus(pr({
    rollup: [
      check({ status: "COMPLETED", conclusion: "SUCCESS", name: "build" }),
      check({ status: "COMPLETED", conclusion: "SKIPPED", name: "stale-comment" }),
      check({ status: "COMPLETED", conclusion: "SKIPPED", name: "fast-track" }),
    ],
  }), AT)
  assert.equal(s.checks, "passing", "something did genuinely pass")
  assert.deepEqual([s.passed, s.skipped], [1, 2])
})

test("nodejs/node#65795, verbatim: the reading that produced `15 checks green` now reads as gated", () => {
  // The real rollup, 2026-09-04T15:13:03Z on head d52830ae: 3 real bot successes, 12 skips.
  const rollup = [
    check({ status: "COMPLETED", conclusion: "SUCCESS", name: "label" }),
    check({ status: "COMPLETED", conclusion: "SUCCESS", name: "Resolve contributor status" }),
    check({ status: "COMPLETED", conclusion: "SUCCESS", name: "Apply contributor guidance" }),
    ...["notable-change", "fast-track", "stale-comment", "Notify on Review Wanted"].flatMap((name) =>
      [0, 1, 2].map(() => check({ status: "COMPLETED", conclusion: "SKIPPED", name }))),
  ]
  // …and the 8 workflows GitHub was holding, which produced no check run at all and so appear nowhere
  // in that rollup. `gh run list --commit <sha>` is where they are, and frizz already fetches it.
  const workflowRuns = ["Test Linux", "Test macOS", "Linters", "Coverage Windows", "Build from tarball",
    "Test Shared libraries", "Test and upload documentation to artifacts", "First commit message adheres to guidelines"]
    .map((workflowName) => ({ workflowName, status: "completed", conclusion: "ACTION_REQUIRED" }))

  assert.equal(githubWatchStatus(pr({ rollup }), AT).checks, "passing",
    "the rollup ALONE still reads green — which is exactly why the rollup alone was never enough")
  const s = githubWatchStatus(pr({ rollup, workflowRuns }), AT)
  assert.equal(s.checks, "running", "with the gate visible, nothing about this commit is a pass")
  assert.deepEqual([s.passed, s.skipped, s.gated], [3, 12, 8])
})

test("a failure outranks anything still running, and the failing jobs are NAMED", () => {
  const s = githubWatchStatus(pr({
    rollup: [
      check({ status: "IN_PROGRESS", name: "test" }),
      check({ status: "COMPLETED", conclusion: "FAILURE", name: "lint" }),
      check({ state: "ERROR", context: "deploy" }),
    ],
  }), AT)
  assert.equal(s.checks, "failing")
  assert.deepEqual([s.running, s.passed, s.failed], [1, 0, 2])
  assert.deepEqual(s.failing, ["lint", "deploy"])
})

// An entry frizz cannot classify must never launder itself into a green verdict — the same rule
// `evalRollup` is written to, and the reason a `ci:` wait could never fire on a shape surprise.
test("an unrecognizable entry counts as still running, never as quietly passing", () => {
  const s = githubWatchStatus(pr({ rollup: [check({}), check({ status: "COMPLETED", conclusion: "SUCCESS" })] }), AT)
  assert.equal(s.checks, "running")
  assert.deepEqual([s.running, s.passed], [1, 1])
})

test("mergeability is GitHub's own three words, plus the review gate", () => {
  const green = [check({ status: "COMPLETED", conclusion: "SUCCESS", name: "build" })]
  assert.equal(githubWatchStatus(pr({ rollup: green, mergeable: "MERGEABLE" }), AT).merge, "mergeable")
  assert.equal(githubWatchStatus(pr({ rollup: green, mergeable: "CONFLICTING" }), AT).merge, "conflicting")
  assert.equal(githubWatchStatus(pr({ rollup: green }), AT).merge, "unknown", "no reading is not a verdict")
  // `blocked` is deliberately coarse: a required review and a failing required check are reported the
  // same way by GitHub, and frizz has no business claiming to tell them apart.
  assert.equal(
    githubWatchStatus(pr({ rollup: green, mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED" }), AT).merge,
    "blocked",
  )
  assert.equal(
    githubWatchStatus(pr({ rollup: [check({ status: "COMPLETED", conclusion: "FAILURE" })], mergeable: "MERGEABLE" }), AT).merge,
    "blocked",
  )
})

test("a merged or closed PR says so", () => {
  assert.equal(githubWatchStatus(pr({ state: "MERGED", mergedAt: AT }), AT).state, "merged")
  assert.equal(githubWatchStatus(pr({ state: "CLOSED" }), AT).state, "closed")
  assert.equal(githubWatchStatus(pr(), AT).state, "open")
})

// One bad entry must not take a whole board's worth of PR status with it — this decides a queue rule.
test("the book drops a malformed entry rather than failing the whole read", () => {
  const good = githubWatchStatus(pr(), AT)
  assert.deepEqual(readGithubStatusBook({ [REF]: good, "acme/app#1": { checks: "wat" } }), { [REF]: good })
  assert.deepEqual(readGithubStatusBook(undefined), {})
  assert.deepEqual(readGithubStatusBook([good]), {})
})

// ---- the queue rule ----

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", thread_name: "frizz-t", spawned_at: AT, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: AT, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  } as SessionRow
}
function watching(): SessionTelemetry {
  return {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
    lastActivityAt: LATER, lastAssistantAt: LATER,
    lastFence: { kind: "awaiting", body: "PR up.", hints: [{ kind: "pr", value: REF }] },
  } as unknown as SessionTelemetry
}
const book = (over: Partial<ReturnType<typeof githubWatchStatus>>) =>
  ({ [REF]: { ...githubWatchStatus(pr(), AT), ...over } })

test("checks still running hold the thread OUT of the queue — the active rail, not a card", () => {
  const running = book({ checks: "running", running: 2, passed: 1 })
  assert.equal(deriveNeedsYou(row(), watching(), "turn-idle", false, NOW, undefined, true, false, running, REGISTERED), false)
  // …and the CARD still states the wait, or the drawer blanks at rest and reads as "the agent died".
  assert.equal(deriveAwaitingBackground(row(), watching(), "turn-idle", false, NOW, undefined, false, running, REGISTERED), true)
})

// THE REGISTERED WATCH ALONE HOLDS (2026-09-20). A worker that called `mcp__frizz__watch_pr` and rested
// without a fence — the shape the worker contract steers toward — was queued while its checks ran, while
// the rail's mark read the same registered row and called the thread live. The registry is the signal.
test("a registered watch with no fence holds the thread out of the queue while checks run", () => {
  const unfenced = { ...watching(), lastFence: undefined } as unknown as SessionTelemetry
  const running = book({ checks: "running", running: 2, passed: 1 })
  assert.equal(deriveNeedsYou(row(), unfenced, "turn-idle", false, NOW, undefined, true, false, running, REGISTERED), false)
  // …and with nothing registered the same telemetry is an ordinary rest: a visible handoff.
  assert.equal(deriveNeedsYou(row(), unfenced, "turn-idle", false, NOW, undefined, true, false, running, new Set()), true)
})

// GATED CI DOES NOT HOLD. `checks` reads `running` for workflows parked at GitHub's "Approve and run"
// gate — nothing has settled — but nothing is moving either, and nothing will until a maintainer presses
// the button. A thread held behind that forever would hide, in the Running band, the one PR wait that
// never resolves on its own.
test("a PR whose only unfinished checks are gated requeues the thread; one live run beside the gate still holds", () => {
  const gated = book({ checks: "running", running: 0, gated: 3, gating: ["Test Linux", "Test macOS", "Linters"] })
  assert.equal(deriveNeedsYou(row(), watching(), "turn-idle", false, NOW, undefined, true, false, gated, REGISTERED), true)
  const partlyGated = book({ checks: "running", running: 1, gated: 2, gating: ["Test macOS", "Linters"] })
  assert.equal(deriveNeedsYou(row(), watching(), "turn-idle", false, NOW, undefined, true, false, partlyGated, REGISTERED), false)
})

test("every terminal reading puts it back in the queue", () => {
  for (const [what, over] of [
    ["passing", { checks: "passing" as const, passed: 3 }],
    ["failing", { checks: "failing" as const, failed: 1 }],
    ["no CI at all", { checks: "none" as const }],
    ["merged", { checks: "running" as const, running: 1, state: "merged" as const }],
    ["closed", { checks: "running" as const, running: 1, state: "closed" as const }],
  ] as const) {
    assert.equal(
      deriveNeedsYou(row(), watching(), "turn-idle", false, NOW, undefined, true, false, book(over), REGISTERED),
      true,
      `${what}: the human has something to look at`,
    )
  }
})

// NOT-KNOWING MUST NEVER BE A REASON TO LEAVE THE QUEUE. An unpolled PR — the state every park is in
// for its first few seconds, and the state every park stays in if `gh` is unavailable — reads exactly
// like today: a visible queue handoff.
test("an unpolled PR does not hold, and neither does a reading for a different PR", () => {
  assert.equal(deriveNeedsYou(row(), watching(), "turn-idle", false, NOW, undefined, true, false, {}, REGISTERED), true)
  assert.equal(
    deriveNeedsYou(row(), watching(), "turn-idle", false, NOW, undefined, true, false, { "other/repo#1": { ...githubWatchStatus(pr(), AT), checks: "running" as const, running: 1 } }, REGISTERED),
    true,
  )
})

// ALL of them, not any: with several PRs watched, one finishing is something the human can act on.
test("one finished PR among several requeues the thread", () => {
  const REGISTERED = new Set([REF, "acme/app#392"])
  const two = {
    turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false,
    lastActivityAt: LATER, lastAssistantAt: LATER,
    lastFence: {
      kind: "awaiting",
      body: "two PRs up.",
      hints: [{ kind: "pr", value: REF }, { kind: "pr", value: "acme/app#392" }],
    },
  } as unknown as SessionTelemetry
  const running = { ...githubWatchStatus(pr(), AT), checks: "running" as const, running: 1 }
  const bothRunning = { [REF]: running, "acme/app#392": running }
  const onePassed = { [REF]: running, "acme/app#392": { ...running, checks: "passing" as const } }
  assert.equal(deriveNeedsYou(row(), two, "turn-idle", false, NOW, undefined, true, false, bothRunning, REGISTERED), false)
  assert.equal(deriveNeedsYou(row(), two, "turn-idle", false, NOW, undefined, true, false, onePassed, REGISTERED), true)
})

// ---- the card's rows ----

test("a github watch row carries its PR's status once polled, and nothing before", () => {
  const status = { ...githubWatchStatus(pr(), AT), checks: "running" as const, running: 2 }
  const [polled] = fenceWatchViews("t", watching(), LATER, { [REF]: status }, REGISTERED_ROWS)
  assert.deepEqual(polled.github, status)
  const [unpolled] = fenceWatchViews("t", watching(), LATER, {}, REGISTERED_ROWS)
  assert.equal(unpolled.github, undefined, "an unpolled PR and a PR with no CI are different facts")
  assert.equal(unpolled.target, REF)
  assert.equal(unpolled.kind, "github")
})

// A DECLARATION WITH NO REGISTRATION BEHIND IT IS NOT A WAIT. The fence states what the thread waits on;
// the tool is what makes anything happen. A `pr-watch:` line naming a PR nobody registered describes a
// wake that will never arrive, so it neither cards nor excuses the queue — the same fail-open rule the
// shell declaration gets (maintainer 2026-08-14: "The fence syntax itself is not used to register a
// watcher or a background, anything").
test("an unregistered pr-watch line neither cards nor leaves the queue", () => {
  const running = book({ checks: "running", running: 2 })
  assert.equal(deriveNeedsYou(row(), watching(), "turn-idle", false, NOW, undefined, true, false, running, new Set()), true)
  assert.deepEqual(fenceWatchViews("t", watching(), LATER, running, []), [])
})

// ---- who the PR waits on (board.prWaitsOnNoOne) ----

test("the poll's answer to who a PR waits on reaches the reading, and an unasked field stays absent", () => {
  const node = (over: Record<string, unknown>) => parseGithubPrSnapshot({ state: "OPEN", mergeable: "MERGEABLE", ...over })!
  const read = (over: Record<string, unknown>) => {
    const snap = node(over)
    return githubWatchStatus({ ...snap, rollup: snap.rollup as PrStatus["rollup"] }, AT)
  }
  const idle = read({ mergeQueueEntry: null, autoMergeRequest: null, viewerDidAuthor: true, baseRepository: { viewerPermission: "WRITE" }, reviewRequests: { nodes: [] } })
  assert.deepEqual([idle.mergePath, idle.viewerAuthored, idle.viewerCanMerge, idle.reviewRequested], ["none", true, true, false])
  assert.equal(read({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "teammate" } }] } }).reviewRequested, true)
  // A reviewer with no name to keep is still a reviewer: a team the token cannot see, and a Mannequin.
  assert.equal(read({ reviewRequests: { nodes: [{ requestedReviewer: null }] } }).reviewRequested, true)
  assert.equal(read({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Mannequin" } }] } }).reviewRequested, true)
  assert.equal(read({}).reviewRequested, undefined, "a response that did not list review requests says nothing")
  assert.equal(read({ mergeQueueEntry: { position: 2 }, autoMergeRequest: null }).mergePath, "queued")
  assert.equal(read({ mergeQueueEntry: null, autoMergeRequest: { enabledAt: AT } }).mergePath, "auto")
  const outsider = read({ viewerDidAuthor: false, baseRepository: { viewerPermission: "READ" } })
  assert.deepEqual([outsider.viewerAuthored, outsider.viewerCanMerge], [false, false])
  const unasked = githubWatchStatus(pr(), AT)
  assert.deepEqual([unasked.mergePath, unasked.viewerAuthored, unasked.viewerCanMerge, unasked.reviewRequested], [undefined, undefined, undefined, undefined])
  assert.deepEqual(readGithubStatusBook({ [REF]: idle })[REF], idle, "the stored book keeps the new fields")
})
