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
//
// THE ROLLUP IS PAGED, NOT CAPPED (2026-10-01). 100 is GitHub's largest page, and it was a hard cap
// until nubjs/nub#995 carried 138 contexts: the watch read the first 100, all green, announced "CI
// PASSED" while `Windows embedded runtime and compile` was still running at position 120-odd, and
// never saw it finish — so the thread parked on that job was never woken. A PR whose rollup has a next
// page now has it fetched in a follow-up request (one per page, batched across PRs); one that cannot
// be finished goes back WITHOUT a snapshot, so the scheduler's `gh` fallback, which reads every check,
// answers instead of a verdict over a partial list.
const ROLLUP_PAGE_SIZE = 100
const ROLLUP_MAX_PAGES = 10
const CHECK_SUITE_CAP = 50
const LABEL_CAP = 30
const MERGE_EXIT_CAP = 5
const REVIEW_REQUEST_CAP = 20

export interface GithubReviewRef {
  owner: string
  repo: string
  number: number
  /** What the number names (2026-09-14). Absent means a pull request — every caller and every injected
   *  test fetcher that predates issues sends none. An `issue` ref rides the SAME batched query as the
   *  PRs beside it (one request, however many of each), asks for `issue(number:)` instead of
   *  `pullRequest(number:)`, and answers with `issue` rather than `pr` on its result. */
  kind?: "pull" | "issue"
}

const ASSIGNEE_CAP = 20

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
  // GitHub resolved the repository but not the number: the PR or issue was deleted, transferred, or is
  // not visible to this token. Read off the error's own `path`, so it names exactly one ref in a batch.
  | "not-found"

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
  /** Absent when the response did not say. A PR turned back into a draft cannot merge. */
  isDraft?: boolean
  /** Whether the PR sits in a merge queue right now, and where. Absent when the response did not say. */
  queued?: { position?: number } | null
  /** The PR's latest exits from the merge path that were NOT a merge — see `GithubPrMergeExit`. */
  mergeExits: GithubPrMergeExit[]
  /** Auto-merge is on (`autoMergeRequest` present). Absent when the response did not say. */
  autoMerge?: boolean
  /** The signed-in account opened this PR, and its permission on the base repository (`ADMIN`,
   *  `MAINTAIN`, `WRITE`, `TRIAGE`, `READ`). Absent when the response did not say. */
  viewerDidAuthor?: boolean
  viewerPermission?: string
  /** How many review requests GitHub returned, counted BEFORE `reviewRequests` keeps only the named ones:
   *  a request to a team the token cannot see (`requestedReviewer: null`), a Mannequin or an EnterpriseTeam
   *  has no name to keep, and is still someone the PR waits on. Absent when the response did not say. */
  reviewRequestCount?: number
}

/** A PR leaving the road to its merge without merging: GitHub's merge queue dropping it, or auto-merge
 *  being switched off. Neither moves anything else the watcher reads — the PR's own checks stay green and
 *  its merge state stays clean, because the checks that failed ran on the merge group's commit, not on the
 *  head — so a worker parked on a queued PR slept straight through its PR bouncing out of the queue
 *  (2026-10-14: removed for `failed_checks`, noticed by a human 2h25m later). These are read off the PR's
 *  timeline, so each is an event with an id the cursor can mark.
 *
 *  `rollup` is the merge group's own check rollup, `dequeued` only. GitHub names that commit
 *  `beforeCommit` on the event, and it is the `gh-readonly-queue/…` commit the queue tested — measured
 *  against that PR, whose event's `beforeCommit` was the head SHA of the failed `merge_group` run. */
export interface GithubPrMergeExit {
  id: string
  kind: "dequeued" | "auto-merge-off"
  at?: string
  reason?: string
  actor?: string
  rollup?: unknown[]
}

/** THE ISSUE ITSELF, from the same query — the issue twin of `GithubPrSnapshot`, and everything the
 *  issue watcher can report on: whether it closed (and why), what it is called, and the labels and
 *  assignees whose movement is the issue's own state changing. No checks, no merge — an issue has none,
 *  and a snapshot that carried empty ones would tempt a reader to project a PR verdict off an issue. */
export interface GithubIssueSnapshot {
  state: string
  stateReason?: string
  title?: string
  labels: string[]
  assignees: string[]
  /** GitHub's own comment count, for the card — the activity list below is capped at the last 50. */
  comments: number
}

export type GithubReviewFetchResult =
  // `pr` is absent only when the caller injected a fetcher that does not produce one (every test seam
  // that predates 2026-09-04 does). The poll falls back to its own `gh` fetch in exactly that case, so an
  // older injected fetcher keeps working rather than reporting a PR with no status at all.
  //
  // `issue` is present on an `issue` ref's result and nothing else; there is no `gh` fallback for it,
  // because the issue watcher was born with the batched query and has no older path to fall back to.
  | { status: "ok"; activity: GithubReviewActivity[]; pr?: GithubPrSnapshot; issue?: GithubIssueSnapshot }
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

// The kind is IN the key: a PR and an issue never share a number in one repo, but the two are different
// queries with different results, and a caller that registered #7 both ways must get each answer.
function refKey(ref: GithubReviewRef): string {
  return `${ref.kind === "issue" ? "issue:" : ""}${ref.owner}/${ref.repo}#${ref.number}`
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

/** One page of `statusCheckRollup.contexts` nodes, as rollup entries — shared by the batched query's
 *  first page and every page fetched after it, so a paged-in entry is indistinguishable from the rest. */
function rollupEntries(nodes: unknown): unknown[] {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node: unknown) => {
    if (!node || typeof node !== "object") return []
    const n = node as Record<string, any>
    // The parent workflow's name, which `gh pr view` supplies as `workflowName` on every CheckRun and
    // which `failedCheckNames` falls back to when a job has none of its own.
    const workflowName = n.checkSuite?.workflowRun?.workflow?.name
    return [typeof workflowName === "string" && workflowName ? { ...n, workflowName } : n]
  })
}

/** Whether a `contexts` connection has a page after this one, and the cursor that asks for it. `more`
 *  with no `after` is a page GitHub says exists but gave no way to request: the rollup is unfinishable. */
function rollupNextPage(contexts: unknown): { more: boolean; after?: string } {
  const info = (contexts as { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } | undefined)?.pageInfo
  if (info?.hasNextPage !== true) return { more: false }
  return typeof info.endCursor === "string" && info.endCursor ? { more: true, after: info.endCursor } : { more: true }
}

// The fields every rollup page asks for. The batched query and the follow-up page query MUST select the
// same shape, or the entries a page appends would read differently from the first hundred.
const ROLLUP_NODE_FIELDS = `
              __typename
              ... on CheckRun { name status conclusion detailsUrl completedAt checkSuite { workflowRun { workflow { name } } } }
              ... on StatusContext { context state targetUrl createdAt }`

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
  return {
    state: p.state,
    mergedAt: typeof p.mergedAt === "string" ? p.mergedAt : null,
    ...(typeof p.mergeable === "string" ? { mergeable: p.mergeable } : {}),
    ...(typeof p.reviewDecision === "string" ? { reviewDecision: p.reviewDecision } : {}),
    ...(typeof commit?.oid === "string" && commit.oid ? { head: commit.oid as string } : {}),
    rollup: rollupEntries(commit?.statusCheckRollup?.contexts?.nodes),
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
    // A User or a Bot answers to `login` and a Team to `name`; the row is the reviewer either way.
    reviewRequests: strings(p.reviewRequests?.nodes, (n) => {
      const r = n.requestedReviewer as Record<string, unknown> | undefined
      return r?.login ?? r?.name
    }),
    ...(typeof p.isDraft === "boolean" ? { isDraft: p.isDraft } : {}),
    ...("mergeQueueEntry" in p
      ? { queued: p.mergeQueueEntry && typeof p.mergeQueueEntry === "object"
        ? (Number.isFinite(p.mergeQueueEntry.position) ? { position: p.mergeQueueEntry.position as number } : {})
        : null }
      : {}),
    mergeExits: parseMergeExits(p.timelineItems?.nodes),
    ...("autoMergeRequest" in p ? { autoMerge: Boolean(p.autoMergeRequest) } : {}),
    ...(typeof p.viewerDidAuthor === "boolean" ? { viewerDidAuthor: p.viewerDidAuthor } : {}),
    ...(typeof p.baseRepository?.viewerPermission === "string" ? { viewerPermission: p.baseRepository.viewerPermission } : {}),
    ...(Array.isArray(p.reviewRequests?.nodes) ? { reviewRequestCount: p.reviewRequests.nodes.length } : {}),
  }
}

function parseMergeExits(nodes: unknown): GithubPrMergeExit[] {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node: unknown): GithubPrMergeExit[] => {
    if (!node || typeof node !== "object") return []
    const n = node as Record<string, any>
    const kind = n.__typename === "RemovedFromMergeQueueEvent" ? "dequeued" as const
      : n.__typename === "AutoMergeDisabledEvent" ? "auto-merge-off" as const
      : undefined
    if (!kind || typeof n.id !== "string" || !n.id) return []
    // `reasonCode` first: it is the stable word (`manually_disabled`), where `reason` is GitHub's prose.
    const reason = typeof n.reasonCode === "string" && n.reasonCode ? n.reasonCode : typeof n.reason === "string" && n.reason ? n.reason : undefined
    // A queue that MERGES a PR also records it as removed, with this reason — 29 of the 31 removals on
    // the last 100 bevyengine/bevy PRs. That is the merge, which the PR's own state reports.
    if (kind === "dequeued" && reason?.toLowerCase() === "merged") return []
    const actor = typeof n.actor?.login === "string" && n.actor.login ? n.actor.login as string : undefined
    const contexts = n.beforeCommit?.statusCheckRollup?.contexts?.nodes
    return [{
      id: `${kind}:${n.id}`,
      kind,
      ...(typeof n.createdAt === "string" ? { at: n.createdAt as string } : {}),
      ...(reason ? { reason } : {}),
      ...(actor ? { actor } : {}),
      ...(kind === "dequeued" && Array.isArray(contexts) ? { rollup: rollupEntries(contexts) } : {}),
    }]
  })
}

/** The comments on an ISSUE, in the `GithubReviewActivity` shape the watcher's cursor and steer already
 *  speak — an issue comment and a PR conversation comment are the same GraphQL node, and giving them one
 *  shape means the noise filter, the `seen` cursor and the wake steer need no second grammar. */
export function parseGithubIssueActivities(raw: unknown): GithubReviewActivity[] {
  const issue = (raw as any)?.data?.repository?.issue
  if (!issue || typeof issue !== "object") return []
  // Same normalizer as the PR path, pointed at the issue's comments: wrap them as a PR with no reviews
  // so the one `add` loop above does the field-by-field tolerance, rather than a second copy of it.
  return parseGithubReviewActivities({ data: { repository: { pullRequest: { comments: (issue as any).comments } } } })
}

/** Pure shape normalizer for the issue, held to `parseGithubPrSnapshot`'s standard: a missing field
 *  degrades one reading, never the whole snapshot; no string `state` means indeterminate, not "open". */
export function parseGithubIssueSnapshot(issue: unknown): GithubIssueSnapshot | undefined {
  if (!issue || typeof issue !== "object") return undefined
  const i = issue as Record<string, any>
  if (typeof i.state !== "string" || !i.state) return undefined
  const comments = Number(i.comments?.totalCount)
  return {
    state: i.state,
    ...(typeof i.stateReason === "string" && i.stateReason ? { stateReason: i.stateReason } : {}),
    ...(typeof i.title === "string" && i.title ? { title: i.title.slice(0, 200) } : {}),
    labels: strings(i.labels?.nodes, (n) => n.name),
    assignees: strings(i.assignees?.nodes, (n) => n.login),
    comments: Number.isFinite(comments) && comments >= 0 ? comments : 0,
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
    if (ref.kind === "issue") {
      // The issue fragment: state and why, the title for the card, the last 50 comments in the same
      // node shape as a PR's conversation, and the two lists whose movement is the issue's own state.
      // Priced like the PR fragment — every connection hangs off one issue — so a mixed batch of 20
      // still costs 20 points.
      fields.push(`
      ref${index}: repository(owner: $owner${index}, name: $repo${index}) {
        issue(number: $number${index}) {
          state stateReason title
          comments(last: 50) { totalCount nodes { id url createdAt body author { login __typename } } }
          labels(first: ${LABEL_CAP}) { nodes { name } }
          assignees(first: ${ASSIGNEE_CAP}) { nodes { login } }
        }
      }`)
      return
    }
    fields.push(`
      ref${index}: repository(owner: $owner${index}, name: $repo${index}) {
        pullRequest(number: $number${index}) {
          state mergedAt mergeable reviewDecision isDraft
          mergeQueueEntry { position }
          autoMergeRequest { enabledAt }
          viewerDidAuthor
          baseRepository { viewerPermission }
          timelineItems(last: ${MERGE_EXIT_CAP}, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_DISABLED_EVENT]) { nodes {
            __typename
            ... on RemovedFromMergeQueueEvent { id createdAt reason actor { login }
              beforeCommit { statusCheckRollup { contexts(first: ${ROLLUP_PAGE_SIZE}) { nodes {${ROLLUP_NODE_FIELDS}
              } } } } }
            ... on AutoMergeDisabledEvent { id createdAt reason reasonCode actor { login } }
          } }
          reviews(last: 50) { nodes { id url state submittedAt body author { login __typename } } }
          comments(last: 50) { nodes { id url createdAt body author { login __typename } } }
          labels(first: ${LABEL_CAP}) { nodes { name } }
          reviewRequests(first: ${REVIEW_REQUEST_CAP}) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { name } } } }
          commits(last: 1) { nodes { commit {
            oid
            statusCheckRollup { contexts(first: ${ROLLUP_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes {${ROLLUP_NODE_FIELDS}
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

/** A PR whose rollup has another page to read: the head commit it belongs to, the cursor to resume
 *  from, and the snapshot the page's entries are appended to. */
interface RollupContinuation {
  key: string
  ref: GithubReviewRef
  oid: string
  after: string
  snapshot: GithubPrSnapshot
}

// The follow-up page, addressed by the head COMMIT rather than the pull request: a push between the two
// requests must not splice another commit's checks onto this one's first hundred.
function buildRollupPageQuery(pages: RollupContinuation[]): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = {}
  const declarations: string[] = []
  const fields: string[] = []
  pages.forEach((page, index) => {
    declarations.push(`$owner${index}: String!`, `$repo${index}: String!`, `$oid${index}: GitObjectID!`, `$after${index}: String!`)
    variables[`owner${index}`] = page.ref.owner
    variables[`repo${index}`] = page.ref.repo
    variables[`oid${index}`] = page.oid
    variables[`after${index}`] = page.after
    fields.push(`
      page${index}: repository(owner: $owner${index}, name: $repo${index}) {
        object(oid: $oid${index}) { ... on Commit {
          statusCheckRollup { contexts(first: ${ROLLUP_PAGE_SIZE}, after: $after${index}) { pageInfo { hasNextPage endCursor } nodes {${ROLLUP_NODE_FIELDS}
          } } }
        } }
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

  const graphql = (authToken: string, query: string, variables: Record<string, string | number>, signal: AbortSignal) =>
    request("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
        "user-agent": "frizz-pr-watch",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
      signal,
    })

  // Read every remaining rollup page, appending to each snapshot in place; returns the PRs whose rollup
  // could NOT be finished. Any failure here is that — a timeout, an HTTP error, a missing page, a page
  // past the cap — and none of them is reported as an error: the PR's activity read fine, and its status
  // still has a reader that sees every check, the scheduler's `gh` fallback. Reporting a verdict over the
  // checks read so far is the one thing this must never do.
  const fetchRollupPages = async (authToken: string, pages: RollupContinuation[]): Promise<RollupContinuation[]> => {
    const unfinished: RollupContinuation[] = []
    let open = pages
    for (let page = 2; open.length > 0; page++) {
      if (page > ROLLUP_MAX_PAGES) {
        unfinished.push(...open)
        break
      }
      const { query, variables } = buildRollupPageQuery(open)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      timeout.unref?.()
      let body: any
      try {
        const response = await graphql(authToken, query, variables, controller.signal)
        body = response.ok ? parseJson(await response.text()) : undefined
      } catch {
        body = undefined
      } finally {
        clearTimeout(timeout)
      }
      if (!body || typeof body !== "object") {
        unfinished.push(...open)
        break
      }
      updateBudget(body?.data?.rateLimit)
      const next: RollupContinuation[] = []
      open.forEach((continuation, index) => {
        const contexts = body?.data?.[`page${index}`]?.object?.statusCheckRollup?.contexts
        if (!Array.isArray(contexts?.nodes)) {
          unfinished.push(continuation)
          return
        }
        continuation.snapshot.rollup.push(...rollupEntries(contexts.nodes))
        const more = rollupNextPage(contexts)
        if (!more.more) return
        if (more.after) next.push({ ...continuation, after: more.after })
        else unfinished.push(continuation)
      })
      open = next
    }
    return unfinished
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
      response = await graphql(authToken, query, variables, controller.signal)
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
    const continuations: RollupContinuation[] = []
    const notFound = new Map<string, string>()
    for (const error of Array.isArray((body as any)?.errors) ? (body as any).errors : []) {
      const alias = Array.isArray(error?.path) ? error.path[0] : undefined
      if (error?.type === "NOT_FOUND" && typeof alias === "string") notFound.set(alias, typeof error.message === "string" ? error.message : "not found")
    }
    refs.forEach((ref, index) => {
      const repository = (body as any)?.data?.[`ref${index}`]
      const missing = notFound.get(`ref${index}`)
      if (missing && !(ref.kind === "issue" ? repository?.issue : repository?.pullRequest)) {
        results.set(refKey(ref), { status: "error", failure: { kind: "not-found", message: `GitHub: ${missing}` } })
        return
      }
      if (ref.kind === "issue") {
        const issue = repository?.issue
        if (!issue || typeof issue !== "object") {
          results.set(refKey(ref), {
            status: "error",
            failure: {
              kind: graphRateLimited ? "rate-limit" : genericGraphError ? "graphql" : "shape",
              message: graphRateLimited
                ? `GitHub API rate limit exhausted${graphResetAt ? `; resets at ${graphResetAt}` : ""}`
                : genericGraphError
                  ? `GitHub GraphQL error: ${genericGraphError}`
                : `GitHub returned no accessible issue for ${refKey(ref)}`,
              ...(graphRateLimited && graphResetAt ? { retryAt: graphResetAt } : {}),
            },
          })
          return
        }
        const activity = parseGithubIssueActivities({ data: { repository: { issue } } })
        const snapshot = parseGithubIssueSnapshot(issue)
        results.set(refKey(ref), { status: "ok", activity, ...(snapshot ? { issue: snapshot } : {}) })
        return
      }
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
      const more = rollupNextPage((pr as any).commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts)
      if (snapshot && more.more) {
        if (more.after && snapshot.head) continuations.push({ key: refKey(ref), ref, oid: snapshot.head, after: more.after, snapshot })
        else {
          results.set(refKey(ref), { status: "ok", activity })
          return
        }
      }
      results.set(refKey(ref), { status: "ok", activity, ...(snapshot ? { pr: snapshot } : {}) })
    })
    if (continuations.length > 0) {
      // A rollup that cannot be read to the end goes back with no snapshot at all, never a partial one.
      for (const unfinished of await fetchRollupPages(authToken, continuations)) {
        const result = results.get(unfinished.key)
        if (result?.status === "ok") results.set(unfinished.key, { status: "ok", activity: result.activity })
      }
    }
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
