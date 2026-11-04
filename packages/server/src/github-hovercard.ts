import type { GithubRefCard, GithubRefPreviewResult } from "@frizz/shared"
import { defaultGetToken } from "./github-review.ts"
import { rejectFrizzGithubToken } from "./github-credential.ts"

// Hovercard data for the GitHub references the web client autolinks into rendered prose — `#123`,
// `owner/repo#123`, a bare commit hash (web/lib/githubAutolink.ts mints those anchors).
//
// THE WHOLE DESIGN IS "ONE QUERY, THEN NO QUERIES". A hover that fetches is a hover that stalls: even
// a warm GitHub GraphQL round trip is ~300-800ms from here, which is longer than a pointer rests on a
// link. So the client hands over every reference on the page AT RENDER TIME, this module answers them
// all in ONE request, and the hover itself is a synchronous read out of the client's store. That is
// also why the batching lives here rather than in `github.ts`'s `gh api graphql` shell-out: a spawned
// `gh` child adds ~200ms of process + keychain to every batch, and this path reuses the memoized
// token and native fetch the PR watcher already proved out (github-review.ts).
//
// ALIASES, NOT VARIABLES, FOR THE REFS. One GraphQL document asks for N issues and M commits across
// any number of repos by aliasing each selection (`r0_i0`, `r0_c1`, …). The alias index is derived
// from the loop counter and the owner/name/number/sha are bound as VARIABLES, so nothing foreign is
// ever concatenated into the query text.

const REQUEST_TIMEOUT_MS = 15_000
// A partial-failure query still returns `data` for every alias that resolved, so a batch is only
// chunked to keep any single document (and its GraphQL point cost) bounded.
const MAX_REFS_PER_QUERY = 25
// The excerpt the card shows. Two-ish lines of body at the card's width; the client clamps visually,
// this keeps the wire payload from carrying a whole issue body per reference.
const BODY_BUDGET = 400

// How long an issue/PR card is served from cache before a hover revalidates it. State (open→closed,
// draft→ready), title and labels all move, so this cannot be indefinite — but it also must not be so
// short that scrolling a transcript re-fetches the same twenty refs. Five minutes is the compromise:
// a card is at most that stale on FIRST hover, and a revalidating hover refreshes it under the reader.
const MUTABLE_TTL_MS = 5 * 60_000

export interface ParsedRef {
  key: string
  owner: string
  name: string
  number?: number
  sha?: string
}

// `owner/repo#123` or `owner/repo@<sha>` — the canonical key the client sends. Anything else is
// dropped rather than guessed at: this string arrives from the browser, and every character of it
// that reaches GitHub does so as a bound variable, so the validation here is about not wasting a
// query slot rather than about injection.
const REF_SEG = "[A-Za-z0-9][A-Za-z0-9._-]*"
const REF_PATTERN = new RegExp(`^(${REF_SEG})/(${REF_SEG})(?:#([1-9]\\d{0,9})|@([0-9a-f]{7,40}))$`)

export function parseRef(ref: string): ParsedRef | null {
  const match = REF_PATTERN.exec(ref)
  if (!match) return null
  const [, owner, name, number, sha] = match
  if (number) {
    const n = Number(number)
    // 2^31 keeps the value inside GraphQL's Int; no repo is anywhere near it.
    if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) return null
    return { key: ref, owner, name, number: n }
  }
  return { key: ref, owner, name, sha }
}

/** A commit's data can never change, so its card is cached for the process lifetime. */
export function isImmutableRef(ref: ParsedRef): boolean {
  return ref.sha !== undefined
}

// ---- the query ----

const ISSUE_FIELDS = `
  ... on Issue {
    __typename number title body state stateReason url createdAt
    author { login avatarUrl }
    labels(first: 6) { nodes { name color } }
    comments { totalCount }
  }
  ... on PullRequest {
    __typename number title body state isDraft url createdAt additions deletions changedFiles
    author { login avatarUrl }
    labels(first: 6) { nodes { name color } }
    comments { totalCount }
  }`

const COMMIT_FIELDS = `
  ... on Commit {
    __typename oid abbreviatedOid url messageHeadline messageBody committedDate
    additions deletions changedFilesIfAvailable
    author { name avatarUrl user { login avatarUrl } }
  }`

export function buildRefQuery(refs: ParsedRef[]): { query: string; variables: Record<string, string | number> } {
  const variables: Record<string, string | number> = {}
  const declarations: string[] = []
  const selections: string[] = []
  refs.forEach((ref, index) => {
    declarations.push(`$owner${index}: String!`, `$name${index}: String!`)
    variables[`owner${index}`] = ref.owner
    variables[`name${index}`] = ref.name
    if (ref.number !== undefined) {
      declarations.push(`$number${index}: Int!`)
      variables[`number${index}`] = ref.number
      selections.push(`  a${index}: repository(owner: $owner${index}, name: $name${index}) {
    target: issueOrPullRequest(number: $number${index}) {${ISSUE_FIELDS}
    }
  }`)
    } else {
      // `object(oid:)` REJECTS an abbreviated sha — the `GitObjectID` scalar wants all 40 characters,
      // and prose almost always carries 7. `expression:` takes any rev-parse string, which is exactly
      // what a short hash is.
      declarations.push(`$rev${index}: String!`)
      variables[`rev${index}`] = ref.sha!
      selections.push(`  a${index}: repository(owner: $owner${index}, name: $name${index}) {
    target: object(expression: $rev${index}) {${COMMIT_FIELDS}
    }
  }`)
    }
  })
  return { query: `query(${declarations.join(", ")}) {\n${selections.join("\n")}\n}`, variables }
}

// ---- parsing ----

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined
}

/** Collapse a body to one excerpt: no leading blank lines, no runaway length, no HTML comments. */
export function excerptBody(body: string | undefined): string {
  if (!body) return ""
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, "").trim()
  if (cleaned.length <= BODY_BUDGET) return cleaned
  return `${cleaned.slice(0, BODY_BUDGET).trimEnd()}…`
}

function labelsOf(v: unknown): { name: string; color: string }[] {
  const nodes = (v as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(nodes)) return []
  const out: { name: string; color: string }[] = []
  for (const node of nodes) {
    const name = str((node as { name?: unknown })?.name)
    if (name) out.push({ name, color: str((node as { color?: unknown })?.color) ?? "" })
  }
  return out
}

/**
 * One GraphQL alias payload → the card, or null when the reference does not resolve.
 *
 * PURE and defensive — this is the unit-tested seam. A null alias (issue deleted, sha not in the
 * repo, repo renamed) and an unrecognized `__typename` both yield null, which the caller records as
 * `missing` so the client stops asking.
 */
export function cardFromNode(ref: ParsedRef, node: unknown, fetchedAt: number): GithubRefCard | null {
  if (!node || typeof node !== "object") return null
  const n = node as Record<string, unknown>
  const repo = `${ref.owner}/${ref.name}`
  const typename = str(n.__typename)

  if (typename === "Commit") {
    const headline = str(n.messageHeadline) ?? ""
    if (!headline) return null
    const author = (n.author ?? {}) as Record<string, unknown>
    const user = (author.user ?? {}) as Record<string, unknown>
    return {
      ref: ref.key,
      kind: "commit",
      repo,
      url: str(n.url) ?? `https://github.com/${repo}/commit/${str(n.oid) ?? ref.sha}`,
      title: headline,
      body: excerptBody(str(n.messageBody)),
      state: "",
      at: str(n.committedDate),
      ...(str(user.login) ? { authorLogin: str(user.login)! } : {}),
      ...(str(author.name) ? { authorName: str(author.name)! } : {}),
      // The LINKED ACCOUNT's avatar first. A commit's `GitActor.avatarUrl` is derived from the
      // committer email, so for an author with no matching account it is a Gravatar behind GitHub's
      // camo image proxy — a different host, and a generic silhouette rather than the person.
      ...(str(user.avatarUrl) || str(author.avatarUrl)
        ? { authorAvatar: (str(user.avatarUrl) ?? str(author.avatarUrl))! }
        : {}),
      labels: [],
      ...(int(n.additions) !== undefined ? { additions: int(n.additions)! } : {}),
      ...(int(n.deletions) !== undefined ? { deletions: int(n.deletions)! } : {}),
      ...(int(n.changedFilesIfAvailable) !== undefined ? { changedFiles: int(n.changedFilesIfAvailable)! } : {}),
      fetchedAt,
    }
  }

  if (typename !== "Issue" && typename !== "PullRequest") return null
  const title = str(n.title)
  if (!title) return null
  const author = (n.author ?? {}) as Record<string, unknown>
  // A DRAFT pull request is `state: OPEN` with `isDraft: true` — GitHub paints it as its own grey
  // state, and reading it as plain "Open" is the difference between "ready for you" and "not yet".
  const state = n.isDraft === true && str(n.state)?.toUpperCase() === "OPEN" ? "DRAFT" : (str(n.state)?.toUpperCase() ?? "")
  return {
    ref: ref.key,
    kind: typename === "Issue" ? "issue" : "pr",
    repo,
    url: str(n.url) ?? `https://github.com/${repo}/issues/${ref.number}`,
    title,
    body: excerptBody(str(n.body)),
    state,
    ...(str(n.stateReason) ? { stateReason: str(n.stateReason)!.toUpperCase() } : {}),
    at: str(n.createdAt),
    ...(str(author.login) ? { authorLogin: str(author.login)! } : {}),
    ...(str(author.avatarUrl) ? { authorAvatar: str(author.avatarUrl)! } : {}),
    labels: labelsOf(n.labels),
    ...(int(n.additions) !== undefined ? { additions: int(n.additions)! } : {}),
    ...(int(n.deletions) !== undefined ? { deletions: int(n.deletions)! } : {}),
    ...(int(n.changedFiles) !== undefined ? { changedFiles: int(n.changedFiles)! } : {}),
    ...(int((n.comments as { totalCount?: unknown } | null)?.totalCount) !== undefined
      ? { comments: int((n.comments as { totalCount?: unknown }).totalCount)! }
      : {}),
    fetchedAt,
  }
}

/** The `a<i>.target` payloads of one response, indexed by the ref that asked for each. PURE. */
export function parseRefResponse(raw: unknown, refs: ParsedRef[], fetchedAt: number): { cards: GithubRefCard[]; missing: string[] } {
  const data = (raw as { data?: Record<string, unknown> } | null)?.data
  const cards: GithubRefCard[] = []
  const missing: string[] = []
  refs.forEach((ref, index) => {
    const alias = (data?.[`a${index}`] ?? null) as { target?: unknown } | null
    const card = cardFromNode(ref, alias?.target, fetchedAt)
    if (card) cards.push(card)
    else missing.push(ref.key)
  })
  return { cards, missing }
}

// ---- the cached fetcher ----

interface CacheEntry {
  card?: GithubRefCard
  missing?: true
  at: number
}

export interface GithubHovercardDeps {
  getToken?: () => Promise<string>
  request?: typeof globalThis.fetch
  now?: () => number
}

export interface GithubHovercardService {
  preview(refs: string[], opts?: { refresh?: boolean }): Promise<GithubRefPreviewResult>
  /** Test seam: how many entries are held right now. */
  size(): number
}

function conciseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) || "unknown error"
}

/**
 * The process-lifetime hovercard cache in front of one batched GraphQL call.
 *
 * FRESHNESS, in three rules:
 *   • a COMMIT is immutable, so its card is never refetched;
 *   • an issue/PR card older than MUTABLE_TTL_MS is refetched on the next request that names it;
 *   • `refresh: true` refetches an issue/PR regardless of age. That is the hover's own revalidation —
 *     the reader already has the cached card on screen, so the request is not on the critical path
 *     and the card simply updates underneath them if anything moved.
 *
 * A `missing` verdict is cached under the same rules, so a `#123` that names nothing does not put a
 * query on the wire every time the transcript scrolls past it.
 *
 * NOTHING HERE THROWS. A hovercard is decoration: no gh, no token, a rate limit or a network stall
 * all come back as `error` on the result, the anchor stays a plain link, and the rest of the app is
 * untouched.
 */
export function createGithubHovercardService(deps: GithubHovercardDeps = {}): GithubHovercardService {
  const getToken = deps.getToken ?? defaultGetToken
  const request = deps.request ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const cache = new Map<string, CacheEntry>()
  // In-flight de-duplication: two prose blocks rendering the same ref in the same frame, or a hover
  // landing on a ref the page-load batch is still fetching, must not each open a request.
  const inflight = new Map<string, Promise<void>>()
  const onTokenRejected = deps.getToken ? () => {} : rejectFrizzGithubToken
  // Asked per batch, never cached here: the credential store keeps it in memory and renews it.
  const token = getToken

  const isFresh = (ref: ParsedRef, entry: CacheEntry, refresh: boolean): boolean => {
    if (isImmutableRef(ref) && entry.card) return true
    if (refresh) return false
    return now() - entry.at < MUTABLE_TTL_MS
  }

  const fetchChunk = async (refs: ParsedRef[]): Promise<void> => {
    const authToken = await token()
    const { query, variables } = buildRefQuery(refs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timeout.unref?.()
    try {
      const response = await request("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
          "user-agent": "frizz-hovercard",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        // 401 means GitHub revoked the token before its expiry. Tell the credential store, which renews
        // an App token on the next ask rather than failing forever against a dead one.
        if (response.status === 401) onTokenRejected(authToken)
        throw new Error(`GitHub GraphQL returned HTTP ${response.status}`)
      }
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error("GitHub GraphQL returned malformed JSON")
      }
      // Per-alias NOT_FOUND errors are EXPECTED and arrive alongside a populated `data`, so the
      // `errors` array is deliberately not fatal — parseRefResponse reads each alias on its own.
      const at = now()
      const { cards, missing } = parseRefResponse(body, refs, at)
      for (const card of cards) cache.set(card.ref, { card, at })
      for (const key of missing) cache.set(key, { missing: true, at })
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    size: () => cache.size,
    async preview(refs, opts = {}) {
      const refresh = opts.refresh === true
      // Dedupe and validate first; an unparseable ref is reported missing without costing a slot.
      const parsed = new Map<string, ParsedRef>()
      const missing: string[] = []
      for (const raw of refs) {
        if (parsed.has(raw)) continue
        const ref = parseRef(raw)
        if (ref) parsed.set(raw, ref)
        else missing.push(raw)
      }

      const wanted: ParsedRef[] = []
      const joins: Promise<void>[] = []
      for (const ref of parsed.values()) {
        const entry = cache.get(ref.key)
        if (entry && isFresh(ref, entry, refresh)) continue
        const pending = inflight.get(ref.key)
        // Already on the wire in another batch — wait for THAT one rather than opening a second.
        if (pending && !refresh) joins.push(pending)
        else wanted.push(ref)
      }

      let error: string | undefined
      if (wanted.length > 0) {
        const chunks: ParsedRef[][] = []
        for (let i = 0; i < wanted.length; i += MAX_REFS_PER_QUERY) chunks.push(wanted.slice(i, i + MAX_REFS_PER_QUERY))
        const runs = chunks.map((chunk) => {
          const run = fetchChunk(chunk)
          // Register before awaiting so a concurrent request joins this one; clear in a `finally` that
          // only removes ITS OWN promise, so a later batch's registration is never dropped.
          for (const ref of chunk) inflight.set(ref.key, run)
          return run.finally(() => {
            for (const ref of chunk) if (inflight.get(ref.key) === run) inflight.delete(ref.key)
          })
        })
        const settled = await Promise.allSettled([...runs, ...joins])
        const failure = settled.find((r) => r.status === "rejected")
        if (failure && failure.status === "rejected") error = conciseError(failure.reason)
      } else if (joins.length > 0) {
        const settled = await Promise.allSettled(joins)
        const failure = settled.find((r) => r.status === "rejected")
        if (failure && failure.status === "rejected") error = conciseError(failure.reason)
      }

      // Answer from the cache in every case — a chunk that failed simply contributes nothing, so a
      // partial batch still hands back every card that DID resolve (this one or an earlier one).
      const cards: GithubRefCard[] = []
      for (const ref of parsed.values()) {
        const entry = cache.get(ref.key)
        if (entry?.card) cards.push(entry.card)
        else if (entry?.missing) missing.push(ref.key)
      }
      return { cards, missing, ...(error ? { error } : {}) }
    },
  }
}
