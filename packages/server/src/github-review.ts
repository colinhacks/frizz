import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000
const GH_MAX_BUFFER = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const MAX_REFS_PER_REQUEST = 20
const RATE_LIMIT_RESERVE = 100
// ONE POLL, ONE REQUEST (2026-09-04). This query used to ask only for reviews and comments, and a
// second, unbatched pair of `gh` subprocesses per PR — `gh pr view` plus `gh run list --commit` — read
// the status beside it. Folding the status in costs NOTHING measurable: the whole query, status and
// activity for a PR together, prices at 1 GraphQL point (measured against nodejs/node#65795), the same
// as the activity alone, because GitHub charges per connection traversed and these all hang off one
// pull request. Twenty PRs still cost 20 points and now spawn no children at all.
//
// The caps are per PR and deliberately generous: a red matrix on a big repo is 60+ contexts, and a
// truncated rollup would silently drop a failing job.
const ROLLUP_CAP = 100
const CHECK_SUITE_CAP = 50
const LABEL_CAP = 30
const REVIEW_REQUEST_CAP = 20

export interface GithubReviewRef {
  owner: string
  repo: string
  number: number
}

export interface GithubReviewActivity {
  id: string
  actor: string
  actorType?: string
  at?: string
  kind: "review" | "comment"
  reviewState?: string
  // The item's own permalink (`…/pull/N#issuecomment-123`, `…#pullrequestreview-456`). The steer that
  // wakes a worker quotes this so the worker can fetch THAT item instead of re-reading the whole
  // thread and re-litigating comments it already handled. Optional: a shape surprise degrades the
  // steer's precision, never the wake itself.
  url?: string
  // The item's RAW markdown body, for the noise filter (`pr-watch-noise.ts`): its tier-2 markers are
  // HTML comments, which `bodyText` strips. Reviews whose substance is inline comments have an empty
  // body — that shape is load-bearing (an empty body is never noise), so absent and empty both parse.
  body?: string
}

export type GithubReviewFailureKind =
  | "gh-missing"
  | "gh-auth"
  | "timeout"
  | "network"
  | "rate-limit"
  | "http"
  | "graphql"
  | "shape"

export interface GithubReviewFailure {
  kind: GithubReviewFailureKind
  message: string
  retryAt?: string
}

/** THE PR ITSELF, from the same query that read its review activity — everything the watcher needs to
 *  decide a verdict, in the shapes `gh pr view --json …` produced when the poll shelled out for them.
 *  That is not a coincidence and it is worth relying on: the CLI's `statusCheckRollup` is a thin pass-
 *  through of the very GraphQL nodes below, so the entries carry the same field names and the scheduler's
 *  `RollupEntry` reads either without a translation layer.
 *
 *  `checkSuites` is the one field with no `gh pr view` equivalent, and it is the reason a gated PR can be
 *  seen at all: a workflow held for a maintainer's approval concludes `ACTION_REQUIRED` at the SUITE and
 *  produces no check run, so it appears nowhere in the rollup. It was previously reached with a second
 *  subprocess (`gh run list --commit <sha>`); now it rides along. */
export interface GithubPrSnapshot {
  state: string
  mergedAt: string | null
  mergeable?: string
  reviewDecision?: string
  head?: string
  rollup: unknown[]
  checkSuites: { status?: string; conclusion?: string; workflowName?: string }[]
  labels: string[]
  /** Reviewers with a request outstanding — a user's login, or a team's name. */
  reviewRequests: string[]
}

export type GithubReviewFetchResult =
  // `pr` is absent only when the caller injected a fetcher that does not produce one (every test seam
  // that predates 2026-09-04 does). The poll falls back to its own `gh` fetch in exactly that case, so an
  // older injected fetcher keeps working rather than reporting a PR with no status at all.
  | { status: "ok"; activity: GithubReviewActivity[]; pr?: GithubPrSnapshot }
  | { status: "deferred" }
  | { status: "error"; failure: GithubReviewFailure }

export type GithubReviewFetcher = (ref: GithubReviewRef) => Promise<GithubReviewFetchResult>

interface GithubReviewFetcherDeps {
  getToken?: () => Promise<string>
  request?: typeof globalThis.fetch
  now?: () => number
}

interface PendingRef {
  ref: GithubReviewRef
  resolve: ((result: GithubReviewFetchResult) => void)[]
}

interface RateLimitShape {
  cost?: unknown
  remaining?: unknown
  resetAt?: unknown
  limit?: unknown
}

function refKey(ref: GithubReviewRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

function conciseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) || "unknown error"
}

// Exported because the hovercard fetcher (github-hovercard.ts) needs the SAME token, read the same
// way: `gh auth token` is the one credential source frizz has, and duplicating this would mean two
// copies of the ENOENT/timeout/`githubFailureKind` classification drifting apart.
export async function defaultGetToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    )
    const token = stdout.trim()
    if (!token) throw new Error("GitHub CLI returned an empty token")
    return token
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") throw Object.assign(new Error("GitHub CLI executable was not found on PATH"), { githubFailureKind: "gh-missing" })
    if ((error as { killed?: unknown })?.killed || code === "ETIMEDOUT") {
      throw Object.assign(new Error(`GitHub CLI token lookup timed out after ${GH_TIMEOUT_MS / 1000}s`), { githubFailureKind: "timeout" })
    }
    throw Object.assign(new Error(`GitHub CLI could not provide an authenticated token: ${conciseError(error)}`), { githubFailureKind: "gh-auth" })
  }
}

// Pure GraphQL-shape normalizer. Missing authors/timestamps are tolerated; an absent PR or malformed
// response yields [] rather than fabricating activity. Source-prefix ids prevent a review/comment id
// collision inside the durable cursor.
export function parseGithubReviewActivities(raw: unknown): GithubReviewActivity[] {
  const pr = (raw as any)?.data?.repository?.pullRequest
  if (!pr || typeof pr !== "object") return []
  const out: GithubReviewActivity[] = []
  const add = (nodes: unknown, kind: "review" | "comment", atKey: "submittedAt" | "createdAt") => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue
      const n = node as Record<string, unknown>
      const rawId = typeof n.id === "string" && n.id ? n.id : undefined
      const author = n.author && typeof n.author === "object" ? (n.author as Record<string, unknown>) : undefined
      const actor = typeof author?.login === "string" && author.login ? author.login : undefined
      if (!rawId || !actor) continue
      const actorType = typeof author?.__typename === "string" ? author.__typename : undefined
      const at = typeof n[atKey] === "string" ? (n[atKey] as string) : undefined
      const reviewState = kind === "review" && typeof n.state === "string" ? n.state : undefined
      const url = typeof n.url === "string" && n.url ? n.url : undefined
      const body = typeof n.body === "string" && n.body ? n.body : undefined
      out.push({
        id: `${kind}:${rawId}`,
        actor,
        actorType,
        at,
        kind,
        ...(reviewState ? { reviewState } : {}),
        ...(url ? { url } : {}),
        ...(body ? { body } : {}),
      })
    }
  }
  add((pr as any)?.reviews?.nodes, "review", "submittedAt")
  add((pr as any)?.comments?.nodes, "comment", "createdAt")
  return out
}

const strings = (nodes: unknown, pick: (n: Record<string, unknown>) => unknown): string[] =>
  (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    if (!node || typeof node !== "object") return []
    const value = pick(node as Record<string, unknown>)
    return typeof value === "string" && value ? [value] : []
  })

/** Pure shape normalizer for the status half, beside `parseGithubReviewActivities` and held to the same
 *  standard: a missing field degrades one reading, never the whole snapshot, and nothing is fabricated.
 *  `undefined` when the response carries no usable pull request — the caller then keeps its previous
 *  reading rather than acting on an invented one. */
export function parseGithubPrSnapshot(pr: unknown): GithubPrSnapshot | undefined {
  if (!pr || typeof pr !== "object") return undefined
  const p = pr as Record<string, any>
  // A SHAPE SURPRISE IS INDETERMINATE, exactly as the `gh` path reads it: no string `state` means frizz
  // cannot say whether this PR is open, and a fabricated "OPEN with no checks" would arm a verdict.
  if (typeof p.state !== "string" || !p.state) return undefined
  const commit = Array.isArray(p.commits?.nodes) ? p.commits.nodes[0]?.commit : undefined
  const contexts = commit?.statusCheckRollup?.contexts?.nodes
  return {
    state: p.state,
    mergedAt: typeof p.mergedAt === "string" ? p.mergedAt : null,
    ...(typeof p.mergeable === "string" ? { mergeable: p.mergeable } : {}),
    ...(typeof p.reviewDecision === "string" ? { reviewDecision: p.reviewDecision } : {}),
    ...(typeof commit?.oid === "string" && commit.oid ? { head: commit.oid as string } : {}),
    rollup: (Array.isArray(contexts) ? contexts : []).flatMap((node: unknown) => {
      if (!node || typeof node !== "object") return []
      const n = node as Record<string, any>
      // The parent workflow's name, which `gh pr view` supplies as `workflowName` on every CheckRun and
      // which `failedCheckNames` falls back to when a job has none of its own.
      const workflowName = n.checkSuite?.workflowRun?.workflow?.name
      return [typeof workflowName === "string" && workflowName ? { ...n, workflowName } : n]
    }),
    checkSuites: (Array.isArray(commit?.checkSuites?.nodes) ? commit.checkSuites.nodes : [])
      .flatMap((node: unknown) => {
        if (!node || typeof node !== "object") return []
        const n = node as Record<string, any>
        const workflowName = n.workflowRun?.workflow?.name
        return [{
          ...(typeof n.status === "string" ? { status: n.status } : {}),
          ...(typeof n.conclusion === "string" ? { conclusion: n.conclusion } : {}),
          ...(typeof workflowName === "string" && workflowName ? { workflowName } : {}),
        }]
      }),
    labels: strings(p.labels?.nodes, (n) => n.name),
    // A User answers to `login` and a Team to `name`; the row is the reviewer either way.
    reviewRequests: strings(p.reviewRequests?.nodes, (n) => {
      const r = n.requestedReviewer as Record<string, unknown> | undefined
      return r?.login ?? r?.name
    }),
  }
}

// Every new review and comment wakes the watcher, whoever filed it. Most PR review today arrives from
// an app — Pullfrog, Copilot, CodeRabbit, Greptile — and the ones that post their findings as a
// CONVERSATION COMMENT rather than a formal review were exactly what an actor-type filter swallowed.
// Distinguishing "real" review from deploy/CI chatter by actor is not something this layer can do
// correctly, and being asleep for a review is far more expensive than one spurious bump. The filter
// that DOES exist (`pr-watch-noise.ts`) is the opposite shape: a measured allowlist-of-nothing —
// named no-substance actors plus self-marked no-substance bodies — with humans never touched.
export function isBotGithubActor(a: Pick<GithubReviewActivity, "actor" | "actorType">): boolean {
  return a.actorType?.toLowerCase() === "bot" || a.actor.toLowerCase().endsWith("[bot]")
}

function buildQuery(refs: GithubReviewRef[]): { query: string; variables: Record<string, string | number> } {
  const variables: Record<string, string | number> = {}
  const declarations: string[] = []
  const fields: string[] = []
  refs.forEach((ref, index) => {
    declarations.push(`$owner${index}: String!`, `$repo${index}: String!`, `$number${index}: Int!`)
    variables[`owner${index}`] = ref.owner
    variables[`repo${index}`] = ref.repo
    variables[`number${index}`] = ref.number
    fields.push(`
      ref${index}: repository(owner: $owner${index}, name: $repo${index}) {
        pullRequest(number: $number${index}) {
          state mergedAt mergeable reviewDecision
          reviews(last: 50) { nodes { id url state submittedAt body author { login __typename } } }
          comments(last: 50) { nodes { id url createdAt body author { login __typename } } }
          labels(first: ${LABEL_CAP}) { nodes { name } }
          reviewRequests(first: ${REVIEW_REQUEST_CAP}) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
          commits(last: 1) { nodes { commit {
            oid
            statusCheckRollup { contexts(first: ${ROLLUP_CAP}) { nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl completedAt checkSuite { workflowRun { workflow { name } } } }
              ... on StatusContext { context state targetUrl createdAt }
            } } }
            checkSuites(first: ${CHECK_SUITE_CAP}) { nodes { status conclusion workflowRun { workflow { name } } } }
          } } }
        }
      }`)
  })
  return {
    query: `query(${declarations.join(", ")}) {
      ${fields.join("\n")}
      rateLimit { cost remaining resetAt limit }
    }`,
    variables,
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function graphErrorMessage(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown })?.errors
  if (!Array.isArray(errors)) return undefined
  const messages = errors
    .map((error) => (error && typeof error === "object" ? (error as { message?: unknown }).message : undefined))
    .filter((message): message is string => typeof message === "string" && message.length > 0)
  return messages.join("; ").slice(0, 500) || undefined
}

function failureFromStatus(status: number, body: unknown, headers: Headers): GithubReviewFailure {
  const apiMessage = typeof (body as { message?: unknown })?.message === "string"
    ? (body as { message: string }).message
    : graphErrorMessage(body)
  const remaining = headers.get("x-ratelimit-remaining")
  const resetSeconds = Number(headers.get("x-ratelimit-reset"))
  const retryAt = Number.isFinite(resetSeconds) && resetSeconds > 0 ? new Date(resetSeconds * 1000).toISOString() : undefined
  if (status === 429 || (status === 403 && (remaining === "0" || /rate limit/i.test(apiMessage ?? "")))) {
    return {
      kind: "rate-limit",
      message: `GitHub API rate limit exhausted${retryAt ? `; resets at ${retryAt}` : ""}`,
      ...(retryAt ? { retryAt } : {}),
    }
  }
  if (status === 401 || status === 403) {
    return { kind: "gh-auth", message: `GitHub rejected the CLI token (HTTP ${status})${apiMessage ? `: ${apiMessage}` : ""}` }
  }
  return { kind: "http", message: `GitHub GraphQL returned HTTP ${status}${apiMessage ? `: ${apiMessage}` : ""}` }
}

// Retrieve the user's token from `gh` once, keep it only in process memory, and use native HTTP for
// polling. Calls made in one scheduler turn coalesce in a microtask into bounded GraphQL batches, so
// N watched threads do not launch N keychain-reading `gh api` children. The response's actual GraphQL
// cost feeds a local budget guard: if the active set would exhaust the remaining hourly allowance at
// a 60s cadence, the next batch is silently deferred long enough to stay within the budget.
export function createGithubReviewFetcher(deps: GithubReviewFetcherDeps = {}): GithubReviewFetcher {
  const getToken = deps.getToken ?? defaultGetToken
  const request = deps.request ?? globalThis.fetch
  const now = deps.now ?? Date.now
  let tokenPromise: Promise<string> | undefined
  let notBeforeMs = 0
  let rateLimitBlockedUntilMs = 0
  let pending = new Map<string, PendingRef>()
  let flushScheduled = false

  const token = async (): Promise<string> => {
    if (!tokenPromise) {
      tokenPromise = getToken().then((value) => {
        const trimmed = value.trim()
        if (!trimmed) throw Object.assign(new Error("GitHub CLI returned an empty token"), { githubFailureKind: "gh-auth" })
        return trimmed
      })
      tokenPromise.catch(() => { tokenPromise = undefined })
    }
    return tokenPromise
  }

  const updateBudget = (rate: RateLimitShape | undefined) => {
    const cost = Number(rate?.cost)
    const remaining = Number(rate?.remaining)
    const resetMs = Date.parse(typeof rate?.resetAt === "string" ? rate.resetAt : "")
    const current = now()
    if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(remaining) || !Number.isFinite(resetMs) || resetMs <= current) return
    const spendable = Math.max(0, remaining - RATE_LIMIT_RESERVE)
    if (spendable < cost) {
      notBeforeMs = Math.max(notBeforeMs, resetMs)
      rateLimitBlockedUntilMs = Math.max(rateLimitBlockedUntilMs, resetMs)
      return
    }
    const sustainableCadence = Math.ceil(((resetMs - current) * cost) / spendable)
    if (sustainableCadence > 60_000) notBeforeMs = Math.max(notBeforeMs, current + sustainableCadence)
  }

  const fetchChunk = async (refs: GithubReviewRef[]): Promise<Map<string, GithubReviewFetchResult>> => {
    const results = new Map<string, GithubReviewFetchResult>()
    let authToken: string
    try {
      authToken = await token()
    } catch (error) {
      const kind = (error as { githubFailureKind?: GithubReviewFailureKind })?.githubFailureKind ?? "gh-auth"
      const result: GithubReviewFetchResult = { status: "error", failure: { kind, message: conciseError(error) } }
      for (const ref of refs) results.set(refKey(ref), result)
      return results
    }

    const { query, variables } = buildQuery(refs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timeout.unref?.()
    let response: Response
    try {
      response = await request("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
          "user-agent": "frizz-pr-watch",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })
    } catch (error) {
      const timedOut = controller.signal.aborted || (error as { name?: unknown })?.name === "AbortError"
      clearTimeout(timeout)
      const result: GithubReviewFetchResult = {
        status: "error",
        failure: {
          kind: timedOut ? "timeout" : "network",
          message: timedOut
            ? `GitHub GraphQL request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
            : `GitHub GraphQL request failed: ${conciseError(error)}`,
        },
      }
      for (const ref of refs) results.set(refKey(ref), result)
      return results
    }

    let text: string
    try {
      text = await response.text()
    } catch (error) {
      const timedOut = controller.signal.aborted || (error as { name?: unknown })?.name === "AbortError"
      clearTimeout(timeout)
      const result: GithubReviewFetchResult = {
        status: "error",
        failure: {
          kind: timedOut ? "timeout" : "network",
          message: timedOut
            ? `GitHub GraphQL response timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
            : `GitHub GraphQL response could not be read: ${conciseError(error)}`,
        },
      }
      for (const ref of refs) results.set(refKey(ref), result)
      return results
    }
    clearTimeout(timeout)
    const body = parseJson(text)
    if (!response.ok) {
      const failure = failureFromStatus(response.status, body, response.headers)
      if (failure.kind === "gh-auth") tokenPromise = undefined
      if (failure.kind === "rate-limit" && failure.retryAt) {
        const retryAt = Date.parse(failure.retryAt)
        notBeforeMs = Math.max(notBeforeMs, retryAt)
        rateLimitBlockedUntilMs = Math.max(rateLimitBlockedUntilMs, retryAt)
      }
      for (const ref of refs) results.set(refKey(ref), { status: "error", failure })
      return results
    }
    if (!body || typeof body !== "object") {
      const result: GithubReviewFetchResult = { status: "error", failure: { kind: "shape", message: "GitHub GraphQL returned malformed JSON" } }
      for (const ref of refs) results.set(refKey(ref), result)
      return results
    }

    updateBudget((body as any)?.data?.rateLimit)
    const genericGraphError = graphErrorMessage(body)
    const graphResetAt = typeof (body as any)?.data?.rateLimit?.resetAt === "string"
      ? (body as any).data.rateLimit.resetAt as string
      : undefined
    const graphRateLimited = !!genericGraphError && /rate limit/i.test(genericGraphError)
    if (graphRateLimited && graphResetAt) {
      const resetMs = Date.parse(graphResetAt)
      if (Number.isFinite(resetMs)) {
        notBeforeMs = Math.max(notBeforeMs, resetMs)
        rateLimitBlockedUntilMs = Math.max(rateLimitBlockedUntilMs, resetMs)
      }
    }
    refs.forEach((ref, index) => {
      const repository = (body as any)?.data?.[`ref${index}`]
      const pr = repository?.pullRequest
      if (!pr || typeof pr !== "object") {
        results.set(refKey(ref), {
          status: "error",
          failure: {
            kind: graphRateLimited ? "rate-limit" : genericGraphError ? "graphql" : "shape",
            message: graphRateLimited
              ? `GitHub API rate limit exhausted${graphResetAt ? `; resets at ${graphResetAt}` : ""}`
              : genericGraphError
                ? `GitHub GraphQL error: ${genericGraphError}`
              : `GitHub returned no accessible pull request for ${refKey(ref)}`,
            ...(graphRateLimited && graphResetAt ? { retryAt: graphResetAt } : {}),
          },
        })
        return
      }
      const activity = parseGithubReviewActivities({ data: { repository: { pullRequest: pr } } })
      const snapshot = parseGithubPrSnapshot(pr)
      results.set(refKey(ref), { status: "ok", activity, ...(snapshot ? { pr: snapshot } : {}) })
    })
    return results
  }

  const flush = async () => {
    flushScheduled = false
    const batch = pending
    pending = new Map()
    if (batch.size === 0) return
    if (now() < notBeforeMs) {
      for (const entry of batch.values()) for (const resolve of entry.resolve) resolve({ status: "deferred" })
      return
    }
    const entries = [...batch.values()]
    for (let offset = 0; offset < entries.length; offset += MAX_REFS_PER_REQUEST) {
      const chunk = entries.slice(offset, offset + MAX_REFS_PER_REQUEST)
      if (offset > 0 && now() < rateLimitBlockedUntilMs) {
        for (const entry of chunk) for (const resolve of entry.resolve) resolve({ status: "deferred" })
        continue
      }
      let results: Map<string, GithubReviewFetchResult>
      try {
        results = await fetchChunk(chunk.map((entry) => entry.ref))
      } catch (error) {
        results = new Map(chunk.map((entry) => [
          refKey(entry.ref),
          {
            status: "error" as const,
            failure: { kind: "network" as const, message: `GitHub review batch failed: ${conciseError(error)}` },
          },
        ]))
      }
      for (const entry of chunk) {
        const result = results.get(refKey(entry.ref)) ?? {
          status: "error" as const,
          failure: { kind: "shape" as const, message: `No GitHub result for ${refKey(entry.ref)}` },
        }
        for (const resolve of entry.resolve) resolve(result)
      }
    }
  }

  return (ref) => new Promise<GithubReviewFetchResult>((resolve) => {
    const key = refKey(ref)
    const existing = pending.get(key)
    if (existing) existing.resolve.push(resolve)
    else pending.set(key, { ref, resolve: [resolve] })
    if (!flushScheduled) {
      flushScheduled = true
      queueMicrotask(() => { void flush() })
    }
  })
}
