import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { GITHUB_DISPATCH_UI_BOUNDARY, type GithubItem } from "@frizz/shared"
import { githubSignedIn, runFrizzGh } from "./github-credential.ts"

// gh-CLI wrapper. Design principles (matching project.ts / open-external.ts): every call is
// execFile with an ARGS ARRAY, NEVER a shell string, so a repo/number can never be reinterpreted
// as a command (no injection surface); the repo string comes from trusted detection and `number`
// is a validated positive integer; every gh call gets a hard TIMEOUT (keyring/network can stall);
// and DETECTION failures degrade gracefully (return false/null — never throw into a board build /
// boot). Listing/hydration DO surface gh errors (rate-limit, network) to their RPC caller rather
// than swallowing them into an empty, misleading result (see risk 7).

const pexec = promisify(execFile)
const GH_TIMEOUT = 8000 // ms — every gh call (and the local git probe); a slow keyring/network must never wedge an RPC or boot
const GH_MAXBUF = 16 * 1024 * 1024 // 16MB — a wide `--json` list can be large

// Run gh with an args array (no shell) and return stdout, AS FRIZZ: `runFrizzGh` hands it Frizz's own
// GitHub credential and an empty config dir, so it never reaches the operator's `gh` sign-in (see
// github-credential.ts). Throws on non-zero exit / timeout — the caller decides whether to degrade
// (detection) or surface (listing/hydration).
async function gh(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout } = await runFrizzGh(args, { timeout: GH_TIMEOUT, maxBuffer: GH_MAXBUF, cwd: opts.cwd })
  return stdout
}

// --- Detection (cached at boot; see context.ts) ---

// `gh --version` exit 0 → the binary is on PATH.
export async function ghInstalled(): Promise<boolean> {
  try {
    await gh(["--version"])
    return true
  } catch {
    return false
  }
}

// Is Frizz signed in to GitHub? Local and instant: it asks whether the server holds a credential it
// believes works (github-credential.ts), never `gh auth status`, which asked the OPERATOR's account and
// cost a network round trip on every page load. A token GitHub has since revoked still reads true here
// until the first read that uses it fails, and that read surfaces GitHub's own error.
export async function ghAuthed(): Promise<boolean> {
  return githubSignedIn()
}

// The authoritative GitHub signal: `gh repo view` in `dir` succeeds ONLY for a gh-resolvable GitHub
// repo (a gitlab/bitbucket origin fails → null). Uses the dir's own git remote (no -R), so it must
// run with cwd=dir. Returns "owner/repo" or null. Never throws.
export async function ghRepo(dir: string): Promise<string | null> {
  try {
    const out = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: dir })
    const s = out.trim()
    return s || null
  } catch {
    return null
  }
}

// The purely LOCAL answer to "is this a GitHub repo", read off the git remote — no network, no gh.
//
// It exists because `gh repo view` is a GraphQL call to api.github.com, so a network blip answers
// "this is not a GitHub repo" for a repo that plainly is, and the trigger's `inRepo && authed` gate
// then hides the whole feature with no explanation. That is the same false negative ghAuthed's
// `gh auth token` fallback was added to kill (2026-08-04) — the auth half got a local fallback and
// the repo half did not, so a GitHub outage still hid the icon. Measured 2026-08-11 against a dead
// proxy: `gh --version` 0, `gh auth token` 0, `gh auth status --active` 1, `gh repo view` 1. The
// server log had named the same window nine minutes earlier ("GitHub GraphQL request failed").
//
// Deliberately narrower than gh: only `origin`, only github.com. gh resolves forks/`gh-resolved`/
// multiple remotes and can name a different repo than origin — so this answer is used to KEEP THE
// DOOR OPEN during an outage, never cached (see resolveRepo in router.ts), and the next query
// re-probes gh and self-corrects. A GHE host is not github.com, so it reads null exactly as today.
export async function gitGithubRemote(dir: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", ["remote", "get-url", "origin"], { timeout: GH_TIMEOUT, cwd: dir })
    return githubRemoteNameWithOwner(stdout)
  } catch {
    return null
  }
}

// "owner/repo" for a github.com remote URL, else null. Pure, so the host-spoof cases are unit-tested:
// `github.com.evil.com` and `evil.com/github.com/o/r` are NOT github.com and must not open the door.
export function githubRemoteNameWithOwner(remoteUrl: string): string | null {
  const url = remoteUrl.trim()
  if (!url) return null
  let host: string
  let path: string
  if (url.includes("://")) {
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  } else {
    // scp-like: [user@]host:owner/repo — git's other remote spelling, and the one `git@github.com:`
    // uses, which `new URL()` does not accept.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url)
    if (!scp) return null
    host = scp[1]
    path = scp[2]
  }
  if (host.toLowerCase() !== "github.com") return null
  const segments = path.replace(/\.git$/, "").split("/").filter((s) => s.length > 0)
  if (segments.length !== 2) return null
  const [owner, repo] = segments
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null
  return `${owner}/${repo}`
}

// The stable (process-lifetime) detection triple, resolved once at boot and cached on ctx.github.
export interface GithubDetection {
  installed: boolean
  inRepo: boolean
  nameWithOwner: string | null
}

// Resolve installed + inRepo/nameWithOwner. Never throws (each probe swallows its own failure), so
// it is safe to call at boot without wedging startup on a broken/absent gh. NOTE: `gh repo view`
// needs auth, so a boot done while signed out caches inRepo:false — the router does NOT trust a
// cached-negative inRepo and re-resolves live (see resolveRepo in router.ts) so a post-boot
// sign-in from Settings lights up the feature without a restart. A POSITIVE result is stable.
export async function detectGithub(dir: string): Promise<GithubDetection> {
  const installed = await ghInstalled()
  if (!installed) return { installed: false, inRepo: false, nameWithOwner: null }
  const nameWithOwner = await ghRepo(dir)
  return { installed: true, inRepo: nameWithOwner !== null, nameWithOwner }
}

// The full status is composed in the router (githubStatus handler), which owns the ctx.github cache
// and warms it via resolveRepo — `authed` is re-checked live there so a mid-session sign-in reflects.

// --- Listing ---

export type GhKind = "issues" | "prs"
export type GhSort = "recent" | "reactions"

// The search API's own sort field — the list ORDER is authoritative (do NOT recompute client-side).
const SEARCH_SORT: Record<GhSort, string> = {
  reactions: "reactions",
  recent: "updated",
}

// GitHub's search API refuses to serve results past the 1000th, whatever `total_count` says. The
// pager must stop THERE rather than offering pages that come back empty.
export const SEARCH_RESULT_WINDOW = 1000

// A search row's reaction total: `reactions: { total_count, "+1": … }` — the same "all reactions"
// number the `sort=reactions` ranking uses. Pure + defensive; a foreign shape yields 0, never throws.
export function reactionCount(v: unknown): number {
  const n = (v as { total_count?: unknown } | null)?.total_count
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0
}

// The search API returns `comments` as a plain COUNT. Tolerate the array shape too (the older
// `gh issue list --json comments` returned the full comment array). Absent → undefined.
export function commentCount(v: unknown): number | undefined {
  if (Array.isArray(v)) return v.length
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v
  return undefined
}

// gh `labels` = `[{ name, color, … }]` — keep the name + 6-hex color for the row chips. Defensive:
// a foreign shape yields []; nameless entries are dropped.
export function parseLabels(v: unknown): { name: string; color: string }[] {
  if (!Array.isArray(v)) return []
  const out: { name: string; color: string }[] = []
  for (const l of v) {
    const o = l as { name?: unknown; color?: unknown }
    if (typeof o?.name === "string" && o.name) out.push({ name: o.name, color: typeof o?.color === "string" ? o.color : "" })
  }
  return out
}

// One page of the picker's list, plus the numbers the pager needs to render "Page P of N".
export interface GithubListPage {
  items: GithubItem[]
  /** Every open item matching the query, not just this page (search's `total_count`). */
  total: number
  /** The page actually served — the request's, clamped into the servable window. */
  page: number
  /** How many pages the pager may offer — `total` clamped to the search API's 1000-result window. */
  pageCount: number
}

// Parse a `search/issues` response body into GithubItems. PURE + defensive (this is the unit-tested
// seam — tests inject API JSON here instead of shelling out): bad rows are skipped, missing fields
// default, and `kind` stamps the item discriminant.
//
// The REST search shape differs from the old `gh {issue,pr} list --json` one, so the remap is
// explicit: `html_url`→url, `user.login`→author, `reactions.total_count`→reactions, `draft`→isDraft,
// and `state` is UPPERCASED so rows keep the "OPEN"/"CLOSED" casing the picker has always seen.
// `comments` is stamped for ISSUES only, matching what the list has always shown (search returns a
// count for PRs too, but a PR comment badge is not part of this row's design).
export function parseSearchJson(raw: string, kind: GhKind): { items: GithubItem[]; total: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { items: [], total: 0 }
  }
  const body = parsed as { items?: unknown; total_count?: unknown } | null
  const arr = body?.items
  if (!Array.isArray(arr)) return { items: [], total: 0 }
  const itemKind = kind === "issues" ? "issue" : "pr"
  const out: GithubItem[] = []
  for (const row of arr) {
    const r = row as Record<string, unknown>
    const number = typeof r?.number === "number" ? r.number : Number(r?.number)
    if (!Number.isInteger(number) || number <= 0) continue
    const item: GithubItem = {
      kind: itemKind,
      number,
      title: typeof r?.title === "string" ? r.title : "",
      url: typeof r?.html_url === "string" ? r.html_url : "",
      reactions: reactionCount(r?.reactions),
      updatedAt: typeof r?.updated_at === "string" ? r.updated_at : "",
      labels: parseLabels(r?.labels),
    }
    if (kind === "issues") {
      const c = commentCount(r?.comments)
      if (c !== undefined) item.comments = c
    }
    if (typeof r?.created_at === "string") item.createdAt = r.created_at
    const login = (r?.user as { login?: unknown } | null)?.login
    if (typeof login === "string") item.author = login
    if (typeof r?.state === "string") item.state = r.state.toUpperCase()
    if (typeof r?.draft === "boolean") item.isDraft = r.draft
    out.push(item)
  }
  const rawTotal = body?.total_count
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0 ? Math.trunc(rawTotal) : out.length
  return { items: out, total }
}

// How many pages the pager may offer for `total` results at `perPage` — always at least 1 (an empty
// repo still renders "Page 1 of 1"), and never past the search API's 1000-result window.
export function pageCountFor(total: number, perPage: number): number {
  if (!Number.isFinite(total) || total <= 0 || perPage <= 0) return 1
  return Math.max(1, Math.ceil(Math.min(total, SEARCH_RESULT_WINDOW) / perPage))
}

// --- Linked closing PRs (issues only) ---

// `gh issue list --json` has no linked-PR field, so the closing PR comes from ONE extra GraphQL call
// per listing: `Issue.closedByPullRequestsReferences` is GitHub's own "linked pull requests" edge —
// the same thing the issue page shows — populated by a closing keyword (Closes/Fixes/Resolves #N) in
// a PR body. One aliased query covers the whole page of issues, so this is a single round trip.
type LinkedPrs = NonNullable<GithubItem["linkedPrs"]>

// Reduce an issue's linked set to the badge: how many PRs qualify, plus the ONE the badge links to.
// A PR closed WITHOUT merging no longer closes anything, so it is excluded from both the count and
// the pick — showing it would read as "handled" when the issue is in fact unowned. The primary is
// OPEN over MERGED: on an open issue a merged link is usually a partial/earlier fix, while the open
// one is the work actually in flight.
export function summarizeLinkedPrs(nodes: unknown): LinkedPrs | undefined {
  if (!Array.isArray(nodes)) return undefined
  let count = 0
  let open: LinkedPrs | undefined
  let merged: LinkedPrs | undefined
  for (const node of nodes) {
    const n = node as { number?: unknown; url?: unknown; state?: unknown; isDraft?: unknown }
    const number = typeof n?.number === "number" ? n.number : Number(n?.number)
    if (!Number.isInteger(number) || number <= 0) continue
    const state = typeof n?.state === "string" ? n.state.toUpperCase() : ""
    if (state !== "OPEN" && state !== "MERGED") continue
    count += 1
    const pr: LinkedPrs = { count: 0, number, url: typeof n?.url === "string" ? n.url : "", state }
    if (typeof n?.isDraft === "boolean") pr.isDraft = n.isDraft
    if (state === "OPEN") open ??= pr
    else merged ??= pr
  }
  const primary = open ?? merged
  return primary ? { ...primary, count } : undefined
}

// Build the aliased query. Aliases are `i<number>` — derived from the validated integer, never from
// foreign text, so the query string cannot be shaped by anything but a number.
export function linkedPrQuery(numbers: number[]): string {
  const fields = numbers
    .map((n) => `    i${n}: issue(number: ${n}) { number closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number url state isDraft } } }`)
    .join("\n")
  return `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n${fields}\n  }\n}`
}

// Parse the aliased GraphQL response into number → linked-PR summary. PURE + defensive (the
// unit-tested seam): a foreign shape, a null alias (issue vanished), or an empty node list all yield
// no entry.
export function parseLinkedPrJson(raw: string): Map<number, LinkedPrs> {
  const out = new Map<number, LinkedPrs>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  const repo = (parsed as { data?: { repository?: unknown } })?.data?.repository
  if (!repo || typeof repo !== "object") return out
  for (const value of Object.values(repo as Record<string, unknown>)) {
    const issue = value as { number?: unknown; closedByPullRequestsReferences?: { nodes?: unknown } } | null
    const number = typeof issue?.number === "number" ? issue.number : undefined
    if (number === undefined) continue
    const pr = summarizeLinkedPrs(issue?.closedByPullRequestsReferences?.nodes)
    if (pr) out.set(number, pr)
  }
  return out
}

// 100 aliases × 5 nodes is a big single query, so the page is chunked — and the chunks go out
// CONCURRENTLY, which keeps the enrichment to ONE round trip's latency however long the page is.
// Measured on cli/cli at limit 60 (3 chunks): one chunk is ~0.8-1.2s, sequential chunks put the whole
// call at 7.3s, parallel at 5.0s — against a `gh issue list` that is itself 3.9-5.0s there.
const LINKED_PR_CHUNK = 25

// Attach each issue's linked closing PR IN PLACE. DEGRADES SILENTLY on any gh/GraphQL failure (an
// unavailable badge must never take down the listing itself — the list is the feature, the badge is
// a hint), and a partial result still decorates the chunks that succeeded.
export async function attachLinkedPrs(repo: string, items: GithubItem[]): Promise<void> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) return
  const numbers = items.filter((it) => it.kind === "issue").map((it) => it.number)
  if (numbers.length === 0) return
  const chunks: number[][] = []
  for (let i = 0; i < numbers.length; i += LINKED_PR_CHUNK) chunks.push(numbers.slice(i, i + LINKED_PR_CHUNK))
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        return parseLinkedPrJson(await gh(["api", "graphql", "-f", `query=${linkedPrQuery(chunk)}`, "-F", `owner=${owner}`, "-F", `name=${name}`]))
      } catch {
        // Rate limit, network, an older gh — leave this chunk's rows unbadged and keep going.
        return new Map<number, LinkedPrs>()
      }
    }),
  )
  const found = new Map<number, LinkedPrs>(results.flatMap((m) => [...m]))
  for (const it of items) {
    const pr = found.get(it.number)
    if (it.kind === "issue" && pr) it.linkedPrs = pr
  }
}

// The picker's page size — 30 rows, the width of one scroll through the list.
export const GITHUB_PAGE_SIZE = 30

// Clamp the page size to the search API's sane range (the schema already bounds 1..100;
// belt-and-suspenders).
function clampPerPage(perPage: number): number {
  if (!Number.isInteger(perPage)) return GITHUB_PAGE_SIZE
  return Math.max(1, Math.min(100, perPage))
}

// Clamp the requested page into the servable window, so a stale "next" click (the repo shrank under
// an open picker) lands on the last REAL page instead of an empty one.
function clampPage(page: number, perPage: number): number {
  if (!Number.isInteger(page) || page < 1) return 1
  return Math.max(1, Math.min(page, Math.ceil(SEARCH_RESULT_WINDOW / perPage)))
}

// One PAGE of a repo's open issues or PRs, search-sorted. Goes through `search/issues` rather than
// `gh issue list` for exactly two reasons: the search API takes `page`/`per_page` (gh's own list
// command has no offset, so paging it means re-fetching every earlier page and throwing it away), and
// it returns `total_count`, which is what lets the pager say "Page 2 of 33". The data source is
// unchanged — `gh issue list --search` was already querying this same API.
//
// Lets a gh error (rate limit / network) PROPAGATE to the RPC caller (surfaced, not swallowed —
// risk 7). Only a malformed-but-successful JSON body degrades to an empty page.
export async function listItems(repo: string, kind: GhKind, sort: GhSort, page: number, perPage: number): Promise<GithubListPage> {
  const size = clampPerPage(perPage)
  const wanted = clampPage(page, size)
  const raw = await gh([
    "api",
    "-X",
    "GET",
    "search/issues",
    "-f",
    `q=repo:${repo} is:${kind === "issues" ? "issue" : "pr"} is:open`,
    "-f",
    `sort=${SEARCH_SORT[sort]}`,
    "-f",
    "order=desc",
    "-f",
    `per_page=${size}`,
    "-f",
    `page=${wanted}`,
  ])
  const { items, total } = parseSearchJson(raw, kind)
  if (kind === "issues") await attachLinkedPrs(repo, items)
  const pageCount = pageCountFor(total, size)
  return { items, total, page: Math.min(wanted, pageCount), pageCount }
}

// --- Hydration (at dispatch, fresh full body) ---

export interface HydratedIssue {
  number: number
  title: string
  body: string
  url: string
  labels: string[]
}
export interface HydratedPr extends HydratedIssue {
  files: number
}

// labels arrive as `[{ name, … }]`; keep just the names. Defensive against a foreign shape.
function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((l) => (l as { name?: unknown })?.name).filter((n): n is string => typeof n === "string")
}

// Guard the issue/PR number before it becomes a gh argv token. There is no shell (args array), so
// this is not an injection guard — it just refuses to spend a gh call on a nonsensical number.
function requirePositiveInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid issue/PR number: ${String(n)}`)
  return n
}

export async function hydrateIssue(repo: string, n: number): Promise<HydratedIssue> {
  const num = requirePositiveInt(n)
  const raw = await gh(["issue", "view", String(num), "-R", repo, "--json", "number,title,body,url,labels,reactionGroups"])
  const d = JSON.parse(raw) as Record<string, unknown>
  return {
    number: typeof d.number === "number" ? d.number : num,
    title: typeof d.title === "string" ? d.title : "",
    body: typeof d.body === "string" ? d.body : "",
    url: typeof d.url === "string" ? d.url : "",
    labels: labelNames(d.labels),
  }
}

export async function hydratePr(repo: string, n: number): Promise<HydratedPr> {
  const num = requirePositiveInt(n)
  // `files` is the only extra field the review template / picker consumes; additions/deletions are
  // not surfaced, so they are not fetched.
  const raw = await gh(["pr", "view", String(num), "-R", repo, "--json", "number,title,body,url,labels,files"])
  const d = JSON.parse(raw) as Record<string, unknown>
  return {
    number: typeof d.number === "number" ? d.number : num,
    title: typeof d.title === "string" ? d.title : "",
    body: typeof d.body === "string" ? d.body : "",
    url: typeof d.url === "string" ? d.url : "",
    labels: labelNames(d.labels),
    files: Array.isArray(d.files) ? d.files.length : 0,
  }
}

// --- Prompt templating (pure; unit-tested) ---

// The TASK prompt is the worker's FIRST USER MESSAGE (not the system-prompt file), so a giant issue/PR
// body lands whole in the thread's opening context. The cap was originally an OS arg-length guard,
// back when the prompt rode a CLI arg; dispatch now hands it to the session broker / app-server daemon
// as a JSON message over the daemon's socket, so no length limit applies and what the cap buys is
// context. Cap the body defensively and mark the cut with a pointer to the full item. ~8KB preserves
// the substance of essentially every real item.
const BODY_CAP = 8 * 1024
export function truncateBody(body: string, n: number, kind: "issue" | "pr"): string {
  if (body.length <= BODY_CAP) return body
  const cut = body.slice(0, BODY_CAP).trimEnd()
  const cmd = kind === "issue" ? `gh issue view ${n}` : `gh pr view ${n}`
  return `${cut}\n\n… [truncated — read full via \`${cmd}\`]`
}

function labelsLine(labels: string[]): string {
  return labels.join(", ") || "none"
}

// --- The default template (exported; the batch handler prefers the user's Settings override) ---
//
// This is a TEMPLATE STRING with {token} placeholders that renderGithubPrompt substitutes:
// {repo} {n} {title} {url} {labels} {body}. It deliberately does NOT carry the leading generated
// envelope (`THREAD`, compact UI lead, presentation boundary) — renderGithubPrompt prepends that so a
// user's custom template can never omit/mangle the thread binding or flood the first bubble. Edit
// this to change the shipped default; a user override supersedes at dispatch time.
//
// ONE template covers BOTH kinds. There were two — an issue one and a PR one — until 2026-08-15, and
// keeping them in step was pure tax: the instructions overlapped almost entirely, and the only real
// per-kind difference is which `gh` command reads the item, which the metadata block below states for
// each. The template branches in PROSE ("If it is a BUG REPORT…", "If it is a PR: review it") and the
// worker picks the branch that applies. See the `githubPrompt` comment in shared for the settings side.
//
// SHAPE, and it is the point of the default: instruction PARAGRAPHS carrying NO tokens, then a trailing
// metadata block that carries all of them, alongside the exact `gh` commands. Someone tuning the prompt
// in Settings rewrites the prose and leaves the block alone — they never have to know the token
// vocabulary to make the edit they came for. Keep that split when editing: a token that creeps back
// into the prose puts the tags right where the user is typing.
//
// {body} is deliberately NOT inlined. The picker that dispatches these prompts is gated on gh being
// installed AND authed, so the worker can always read the body itself — the block hands it the exact
// command, which is strictly better than a copy: never truncated, and it picks up the comments in the
// same call. That also keeps prompt transport small (the task prompt is a CLI arg, not the
// system-prompt file — see dispatch.ts).
//
// Each paragraph is ONE unwrapped line on purpose. It is edited in a fixed-width textarea (Settings →
// Prompts), which soft-wraps: hard newlines at some source column would mix with that wrap and render
// ragged in the box the user actually types in. Blank lines BETWEEN paragraphs are structural and fine;
// a hard newline INSIDE one is the regression the golden test guards. The metadata block wraps
// naturally, one field per line, so its newlines are structural too.
//
// The prose below is the maintainer's own (2026-08-15), copy-corrected on their say-so the next day:
// "thoroug" → "thorough", "theads" → "threads", "the impact the of changes" → "the impact of the
// changes", one stray double space, and the heading "Issue #{n}" → "Issue/PR #{n}" so a dispatched PR
// is not labelled an issue. Wording is otherwise theirs — change the MEANING only when they ask.
export const DEFAULT_GITHUB_PROMPT = `Triage this GitHub issue/PR and make recommendations. Be thoughtful, thorough, and dubious. Think through whether this is truly a good idea or not. Many ideas are bad.

Read the full thread first — body, labels, and the whole discussion — then classify the report as a BUG or a FEATURE request and say which it is and why.

If it is a BUG REPORT: establish whether the reported behavior actually happens on the current tree (capture the exact steps, command and output if it reproduces; say what you saw instead if it does not), trace the cause to concrete code, and state the smallest correct fix — or the top 2 options with the tradeoff of each — plus the files it touches and the risk. Be sure you have high confidence that the bug is real. There should be a clean and elegant solution. If there isn't an elegant way to do something, then it often means that it's not a good idea or that we are in need of a larger codebase refactor. The issue: you should stay in the codebase for similar categories of bugs. We are constantly seeking to proactively self-improve the codebase.

If it is a FEATURE REQUEST: restate the request precisely (the use-case behind it and any ambiguity a maintainer must resolve), map where it lands in the code and what public API / UX surface it changes, and sketch a concrete plan for the smallest viable version with its risks, open design questions and a rough size estimate.

If it is a PR: review it. Read the PR description, comments, and changes. You should be dubious. Do not assume that the PR is high quality, many are not. For each substantive change ask: is there a better approach? Is it correct? Does it handle edges? Is it elegant? Does it break existing behavior or the public API? Are there tests, and do they actually cover the change? Trace the impact of the changes thoughtfully. Check CI too. Recommend either closing, making changes (explain them), or merging. Test the changes yourself if necessary/possible.

If it is a DOCS CHANGE: make sure that it is well written, minimal, no walls of text, well structured, consistent tonally with others docs/prose, and not AI slop.

Bias always towards proactivity and taking immediate action. If you encounter issues, feel free to add fixes for those in the same PR. Do not worry about perfect git hygiene.

---

Issue/PR #{n}: {title}
Repository: {repo}
URL: {url}
Labels: {labels}
Body + thread (issues): \`gh issue view {n} -R {repo} --comments\`
Body + thread (PRs): \`gh pr view {n} -R {repo} --comments\`
Diff (PRs): \`gh pr diff {n} -R {repo}\`
CI (PRs): \`gh pr checks {n} -R {repo}\``

// --- Pure templater (unit-tested seam) ---

// Common item shape both hydrations satisfy (HydratedPr's extra `files` is unused by the templates).
export interface PromptItem {
  number: number
  title: string
  url: string
  labels: string[]
  body: string
}

// The 6 substitution tokens a template may reference. Kept in one place so the UI hint, the tests,
// and the replace-regex stay in lockstep.
export const PROMPT_TOKENS = ["repo", "n", "title", "url", "labels", "body"] as const

// Render a batch-dispatch prompt from a template STRING (the shipped default OR the user's Settings
// override) against a hydrated item. PURE — the unit-tested seam. Behavior:
//  • Substitutes {repo} {n} {title} {url} {labels} {body} in a SINGLE pass, so a {token} that appears
//    inside a substituted value (e.g. a hostile issue body containing "{repo}") is NOT re-expanded —
//    there is no injection-via-item-content and no order-dependence between tokens.
//  • {body} is truncated defensively (kind-aware pointer) so a giant issue/PR body can't swallow the
//    thread's opening context (the task prompt is the worker's first message, not the system-prompt
//    file — see truncateBody).
//  • Prepends a generated envelope: the `THREAD: <slug>` binding, a compact human-facing GitHub lead,
//    then an exact UI boundary. The FULL substituted template remains below the boundary for the
//    worker; transcript presentation alone hides that machine-facing tail.
//  • An unknown {placeholder} in the template is left verbatim (only the 6 known tokens are replaced).
export function renderGithubPrompt(template: string, repo: string, it: PromptItem, slug: string, kind: "issue" | "pr"): string {
  const subs: Record<(typeof PROMPT_TOKENS)[number], string> = {
    repo,
    n: String(it.number),
    title: it.title,
    url: it.url,
    labels: labelsLine(it.labels),
    body: truncateBody(it.body, it.number, kind),
  }
  const filled = template.replace(/\{(repo|n|title|url|labels|body)\}/g, (_m, k: (typeof PROMPT_TOKENS)[number]) => subs[k])
  const item = kind === "issue" ? "Issue" : "PR"
  const lead = `Investigate this issue and make recommendations\n\n${item} #${it.number}: ${it.title}\nRepository: ${repo}\nURL: ${it.url}`
  return `THREAD: ${slug}\n\n${lead}\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\n${filled}`
}

// Pick the EFFECTIVE template: the user's Settings override when it is present and non-blank, else the
// shipped default. Whitespace-only is treated as unset so a stray space/newline can't blank the prompt.
// Kind-independent since the two templates merged — renderGithubPrompt still takes the kind, because
// the generated lead and the {body} truncation pointer do differ.
export function effectiveTemplate(custom: string | undefined): string {
  if (custom && custom.trim().length > 0) return custom
  return DEFAULT_GITHUB_PROMPT
}
