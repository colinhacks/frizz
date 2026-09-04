import { test } from "node:test"
import assert from "node:assert/strict"
import { createGithubReviewFetcher, parseGithubPrSnapshot } from "./github-review.ts"

const ref = (number: number) => ({ owner: "nubjs", repo: "nub", number })

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

test("review fetcher gets the gh token once and batches + deduplicates same-turn PR reads", async () => {
  let tokenCalls = 0
  const requests: { url: string; init?: RequestInit; body: any }[] = []
  const fetcher = createGithubReviewFetcher({
    getToken: async () => {
      tokenCalls++
      return "secret-from-gh"
    },
    request: async (input, init) => {
      requests.push({ url: String(input), init, body: JSON.parse(String(init?.body)) })
      return response({
        data: {
          ref0: {
            pullRequest: {
              reviews: { nodes: [{ id: "R544", state: "APPROVED", submittedAt: "2026-07-24T17:00:00Z", author: { login: "pullfrog", __typename: "Bot" } }] },
              comments: { nodes: [] },
            },
          },
          ref1: {
            pullRequest: {
              reviews: { nodes: [] },
              comments: { nodes: [{ id: "C549", createdAt: "2026-07-24T17:01:00Z", author: { login: "colinhacks", __typename: "User" } }] },
            },
          },
          rateLimit: { cost: 2, remaining: 4_800, resetAt: "2026-07-24T18:00:00Z", limit: 5_000 },
        },
      })
    },
    now: () => Date.parse("2026-07-24T17:05:00Z"),
  })

  const [first, second, duplicate] = await Promise.all([fetcher(ref(544)), fetcher(ref(549)), fetcher(ref(544))])
  assert.equal(tokenCalls, 1)
  assert.equal(requests.length, 1, "both distinct PRs share one HTTP request")
  assert.equal(requests[0].url, "https://api.github.com/graphql")
  assert.equal(requests[0].init?.headers && (requests[0].init.headers as Record<string, string>).authorization, "Bearer secret-from-gh")
  assert.deepEqual(requests[0].body.variables, {
    owner0: "nubjs",
    repo0: "nub",
    number0: 544,
    owner1: "nubjs",
    repo1: "nub",
    number1: 549,
  })
  assert.deepEqual(first, {
    status: "ok",
    activity: [{ id: "review:R544", actor: "pullfrog", actorType: "Bot", at: "2026-07-24T17:00:00Z", kind: "review", reviewState: "APPROVED" }],
  })
  assert.deepEqual(second, {
    status: "ok",
    activity: [{ id: "comment:C549", actor: "colinhacks", actorType: "User", at: "2026-07-24T17:01:00Z", kind: "comment" }],
  })
  assert.deepEqual(duplicate, first)
})

// The wake steer quotes this permalink so a woken worker can address ONE item instead of re-reading
// the whole thread. Verified against the live GitHub GraphQL schema 2026-07-29: both IssueComment.url
// and PullRequestReview.url return the `#issuecomment-…` / `#pullrequestreview-…` anchors.
test("review fetcher asks for each item's permalink and carries it through to the activity", async () => {
  let body: any
  const fetcher = createGithubReviewFetcher({
    getToken: async () => "t",
    request: async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return response({
        data: {
          ref0: {
            pullRequest: {
              reviews: { nodes: [{ id: "R1", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-1", state: "COMMENTED", submittedAt: "2026-07-29T15:46:04Z", author: { login: "pullfrog", __typename: "Bot" } }] },
              comments: {
                nodes: [
                  { id: "C1", url: "https://github.com/nubjs/nub/pull/587#issuecomment-1", createdAt: "2026-07-29T15:39:28Z", body: "lgtm", author: { login: "colinhacks", __typename: "User" } },
                  // A shape surprise costs the steer its permalink, never the wake itself.
                  { id: "C2", createdAt: "2026-07-29T15:40:00Z", author: { login: "colinhacks", __typename: "User" } },
                ],
              },
            },
          },
          rateLimit: { cost: 1, remaining: 4_900, resetAt: "2026-07-29T18:00:00Z", limit: 5_000 },
        },
      })
    },
    now: () => Date.parse("2026-07-29T15:50:00Z"),
  })

  const got = await fetcher(ref(587))
  // `body` (raw markdown, NOT bodyText — the noise filter's markers are HTML comments) rides both
  // node sets and is omitted from the activity when empty, so the empty-body-review shape survives.
  assert.match(body.query, /reviews\(last: 50\) \{ nodes \{ id url state submittedAt body/)
  assert.match(body.query, /comments\(last: 50\) \{ nodes \{ id url createdAt body/)
  assert.deepEqual(got, {
    status: "ok",
    activity: [
      { id: "review:R1", actor: "pullfrog", actorType: "Bot", at: "2026-07-29T15:46:04Z", kind: "review", reviewState: "COMMENTED", url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-1" },
      { id: "comment:C1", actor: "colinhacks", actorType: "User", at: "2026-07-29T15:39:28Z", kind: "comment", url: "https://github.com/nubjs/nub/pull/587#issuecomment-1", body: "lgtm" },
      { id: "comment:C2", actor: "colinhacks", actorType: "User", at: "2026-07-29T15:40:00Z", kind: "comment" },
    ],
  })
})

test("review fetcher reports gh-token auth failures precisely and retries token lookup next batch", async () => {
  let tokenCalls = 0
  let requestCalls = 0
  const fetcher = createGithubReviewFetcher({
    getToken: async () => {
      tokenCalls++
      if (tokenCalls === 1) throw new Error("not logged in")
      return "fresh-token"
    },
    request: async () => {
      requestCalls++
      return response({
        data: {
          ref0: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          rateLimit: { cost: 1, remaining: 4_000, resetAt: "2026-07-24T18:00:00Z", limit: 5_000 },
        },
      })
    },
  })

  const failed = await fetcher(ref(544))
  assert.equal(failed.status, "error")
  if (failed.status === "error") {
    assert.equal(failed.failure.kind, "gh-auth")
    assert.match(failed.failure.message, /not logged in/)
  }
  assert.equal(requestCalls, 0)

  const recovered = await fetcher(ref(544))
  assert.deepEqual(recovered, { status: "ok", activity: [] })
  assert.equal(tokenCalls, 2)
  assert.equal(requestCalls, 1)
})

test("review fetcher honors the real rate-limit reset without hammering GitHub", async () => {
  let requestCalls = 0
  const clock = { ms: Date.parse("2026-07-24T17:00:00Z") }
  const reset = new Date(clock.ms + 10 * 60_000)
  const fetcher = createGithubReviewFetcher({
    getToken: async () => "token",
    request: async () => {
      requestCalls++
      return response(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset.getTime() / 1000),
          },
        },
      )
    },
    now: () => clock.ms,
  })

  const exhausted = await fetcher(ref(544))
  assert.equal(exhausted.status, "error")
  if (exhausted.status === "error") {
    assert.equal(exhausted.failure.kind, "rate-limit")
    assert.equal(exhausted.failure.retryAt, reset.toISOString())
  }
  clock.ms += 60_000
  assert.deepEqual(await fetcher(ref(544)), { status: "deferred" })
  assert.equal(requestCalls, 1, "the reset guard suppresses another HTTP request")
})

test("review fetcher recognizes GraphQL's HTTP-200 rate-limit error shape", async () => {
  const resetAt = "2026-07-24T17:10:00.000Z"
  let requestCalls = 0
  const fetcher = createGithubReviewFetcher({
    getToken: async () => "token",
    request: async () => {
      requestCalls++
      return response({
        data: { ref0: null, rateLimit: { cost: 1, remaining: 0, resetAt, limit: 5_000 } },
        errors: [{ message: "API rate limit exceeded" }],
      })
    },
    now: () => Date.parse("2026-07-24T17:00:00Z"),
  })

  const exhausted = await fetcher(ref(544))
  assert.deepEqual(exhausted, {
    status: "error",
    failure: {
      kind: "rate-limit",
      message: `GitHub API rate limit exhausted; resets at ${resetAt}`,
      retryAt: resetAt,
    },
  })
  assert.deepEqual(await fetcher(ref(544)), { status: "deferred" })
  assert.equal(requestCalls, 1)
})

test("review fetcher invalidates a rejected token so the next batch asks gh again", async () => {
  let tokenCalls = 0
  let requestCalls = 0
  const fetcher = createGithubReviewFetcher({
    getToken: async () => `token-${++tokenCalls}`,
    request: async () => {
      requestCalls++
      if (requestCalls === 1) return response({ message: "Bad credentials" }, { status: 401 })
      return response({
        data: {
          ref0: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          rateLimit: { cost: 1, remaining: 4_000, resetAt: "2026-07-24T18:00:00Z", limit: 5_000 },
        },
      })
    },
  })

  const rejected = await fetcher(ref(544))
  assert.equal(rejected.status, "error")
  if (rejected.status === "error") assert.equal(rejected.failure.kind, "gh-auth")
  assert.deepEqual(await fetcher(ref(544)), { status: "ok", activity: [] })
  assert.equal(tokenCalls, 2)
})

// ---- THE STATUS HALF, folded into the same query (2026-09-04) ------------------------------------
//
// The poll read the PR's status through two `gh` subprocesses per PR — `gh pr view` for the rollup and
// `gh run list --commit <sha>` for the gated and fork-omitted runs — beside this GraphQL batch. Both
// halves hang off the same pull request and price at the same 1 point together as apart, so the status
// now rides the query that was already being made.
//
// THE FIXTURE BELOW IS THE REAL RESPONSE SHAPE, trimmed. It was read off nodejs/node#65796 on
// 2026-09-04, whose head then carried NINE workflows held at GitHub's fork-approval gate and an EMPTY
// rollup — the exact reading that used to come back as "no checks" while Node's whole matrix sat
// waiting for a maintainer to press the button.
test("the snapshot carries the rollup, the gate, the labels and the review requests", () => {
  const snapshot = parseGithubPrSnapshot({
    state: "OPEN",
    mergedAt: null,
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    labels: { nodes: [{ name: "crypto" }, { name: "c++" }, { name: "needs-ci" }] },
    reviewRequests: { nodes: [
      { requestedReviewer: { __typename: "User", login: "richardlau" } },
      { requestedReviewer: { __typename: "Team", name: "crypto-reviewers" } },
      { requestedReviewer: null }, // a reviewer the token cannot see: dropped, never rendered as blank
    ] },
    commits: { nodes: [{ commit: {
      oid: "4f2868190a2b7f19e5b5c2d7e0f1a3b4c5d6e7f8",
      statusCheckRollup: { contexts: { nodes: [
        { __typename: "CheckRun", name: "lint-js-and-md", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/x/y/actions/runs/1/job/2", checkSuite: { workflowRun: { workflow: { name: "Linters" } } } },
        { __typename: "StatusContext", context: "ci/external", state: "PENDING", targetUrl: "https://ci.example/1" },
      ] } },
      checkSuites: { nodes: [
        { status: "COMPLETED", conclusion: "ACTION_REQUIRED", workflowRun: { workflow: { name: "Test Linux" } } },
        { status: "COMPLETED", conclusion: "ACTION_REQUIRED", workflowRun: { workflow: { name: "Test macOS" } } },
        { status: "COMPLETED", conclusion: "SUCCESS", workflowRun: { workflow: { name: "Label PRs" } } },
        { status: "QUEUED", conclusion: null, workflowRun: null }, // a suite with no run yet: no name to take
      ] },
    } }] },
  })

  assert.ok(snapshot)
  assert.equal(snapshot.state, "OPEN")
  assert.equal(snapshot.head, "4f2868190a2b7f19e5b5c2d7e0f1a3b4c5d6e7f8")
  assert.equal(snapshot.mergeable, "MERGEABLE")
  assert.equal(snapshot.reviewDecision, "REVIEW_REQUIRED")
  assert.deepEqual(snapshot.labels, ["crypto", "c++", "needs-ci"])
  assert.deepEqual(snapshot.reviewRequests, ["richardlau", "crypto-reviewers"], "a user answers to login, a team to name")
  // The rollup entries keep GitHub's own field names, which is what lets `RollupEntry` read the GraphQL
  // nodes and the `gh` output without a translation layer between them.
  assert.deepEqual(snapshot.rollup[0], {
    __typename: "CheckRun", name: "lint-js-and-md", status: "COMPLETED", conclusion: "SUCCESS",
    detailsUrl: "https://github.com/x/y/actions/runs/1/job/2",
    checkSuite: { workflowRun: { workflow: { name: "Linters" } } },
    workflowName: "Linters", // flattened, because `gh pr view` supplies it and `failedCheckNames` reads it
  })
  assert.deepEqual(snapshot.checkSuites, [
    { status: "COMPLETED", conclusion: "ACTION_REQUIRED", workflowName: "Test Linux" },
    { status: "COMPLETED", conclusion: "ACTION_REQUIRED", workflowName: "Test macOS" },
    { status: "COMPLETED", conclusion: "SUCCESS", workflowName: "Label PRs" },
    { status: "QUEUED" },
  ])
})

// A SHAPE SURPRISE IS INDETERMINATE, never "open with no checks" — the same rule the `gh` path has read
// by since 2026-08-25. Inventing a state here would arm a verdict on a PR frizz cannot actually see.
test("a response with no usable pull request yields no snapshot, so the poll keeps its last reading", () => {
  for (const bad of [undefined, null, {}, { state: "" }, { state: 7 }, "OPEN"]) {
    assert.equal(parseGithubPrSnapshot(bad), undefined, JSON.stringify(bad))
  }
  // A PR with a state and nothing else is still usable — every other field degrades to empty on its own.
  const bare = parseGithubPrSnapshot({ state: "MERGED" })
  assert.deepEqual(bare, { state: "MERGED", mergedAt: null, rollup: [], checkSuites: [], labels: [], reviewRequests: [] })
})

test("the batched query asks for the status half too, so no PR needs a second trip", async () => {
  let body: any
  const fetcher = createGithubReviewFetcher({
    getToken: async () => "t",
    request: async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return response({ data: { ref0: { pullRequest: { state: "OPEN", reviews: { nodes: [] }, comments: { nodes: [] } } }, rateLimit: { cost: 1, remaining: 4_999, resetAt: "2026-09-04T18:00:00Z", limit: 5_000 } } })
    },
    now: () => Date.parse("2026-09-04T17:00:00Z"),
  })
  const result = await fetcher(ref(65796))
  for (const field of ["state", "mergedAt", "mergeable", "reviewDecision", "labels", "reviewRequests", "statusCheckRollup", "checkSuites", "oid"]) {
    assert.ok(body.query.includes(field), `the query no longer asks for ${field}`)
  }
  assert.equal(result.status, "ok")
  assert.equal(result.status === "ok" && result.pr?.state, "OPEN", "the snapshot rides back with the activity")
})
