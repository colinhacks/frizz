import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GITHUB_DISPATCH_UI_BOUNDARY } from "@frizz/shared"
import {
  reactionCount,
  commentCount,
  parseSearchJson,
  pageCountFor,
  SEARCH_RESULT_WINDOW,
  summarizeLinkedPrs,
  linkedPrQuery,
  parseLinkedPrJson,
  truncateBody,
  renderGithubPrompt,
  effectiveTemplate,
  ghAuthed,
  gitGithubRemote,
  githubRemoteNameWithOwner,
  DEFAULT_GITHUB_PROMPT,
  PROMPT_TOKENS,
  type HydratedIssue,
  type HydratedPr,
} from "./github.ts"
import { resetGithubCredentialMemo, writeGithubCredential } from "./github-credential.ts"
import { resetFrizzRoots } from "./frizz-paths.ts"

// The parsing/scoring/templating fns are pure, so those tests inject gh output rather than shelling
// out. The ghAuthed tests at the bottom put a signed-in stub `gh` on PATH to prove it is NOT consulted.

// ---- reactionCount ----

test("reactionCount: reads the search row's reactions.total_count", () => {
  assert.equal(reactionCount({ url: "…", total_count: 449, "+1": 347, heart: 71, rocket: 31 }), 449)
  assert.equal(reactionCount({ total_count: 0 }), 0)
})

test("reactionCount: empty / missing / malformed → 0, never throws", () => {
  assert.equal(reactionCount(undefined), 0)
  assert.equal(reactionCount(null), 0)
  assert.equal(reactionCount("nope"), 0)
  assert.equal(reactionCount({}), 0)
  assert.equal(reactionCount({ total_count: "3" }), 0) // non-numeric ignored
  assert.equal(reactionCount({ total_count: -2 }), 0)
})

// ---- pageCountFor ----

test("pageCountFor: rounds up, and an empty list still has one page", () => {
  assert.equal(pageCountFor(0, 30), 1)
  assert.equal(pageCountFor(1, 30), 1)
  assert.equal(pageCountFor(30, 30), 1)
  assert.equal(pageCountFor(31, 30), 2)
  assert.equal(pageCountFor(988, 30), 33)
})

test("pageCountFor: never offers a page past GitHub's servable search window", () => {
  // The API refuses results beyond the 1000th however large total_count is, so the pager must stop
  // where the data does rather than handing out pages that come back empty.
  assert.equal(pageCountFor(50_000, 30), Math.ceil(SEARCH_RESULT_WINDOW / 30))
  assert.equal(pageCountFor(50_000, 100), 10)
})

test("pageCountFor: a nonsense total or page size degrades to one page", () => {
  assert.equal(pageCountFor(Number.NaN, 30), 1)
  assert.equal(pageCountFor(-5, 30), 1)
  assert.equal(pageCountFor(100, 0), 1)
})

// ---- commentCount ----

test("commentCount: array length (the older gh list returned the comment ARRAY, not a count)", () => {
  assert.equal(commentCount([{ body: "a" }, { body: "b" }, { body: "c" }]), 3)
  assert.equal(commentCount([]), 0)
})

test("commentCount: tolerates a bare number; absent/garbage → undefined", () => {
  assert.equal(commentCount(12), 12)
  assert.equal(commentCount(undefined), undefined)
  assert.equal(commentCount(-1), undefined)
  assert.equal(commentCount("5"), undefined)
})

// ---- parseSearchJson ----
//
// The fixtures below are verbatim-shaped `GET /search/issues` rows (snake_case, html_url,
// reactions.total_count, user.login, draft) — the exact wire shape listItems now parses.

test("parseSearchJson: issues — remaps the search shape and carries total_count", () => {
  const raw = JSON.stringify({
    total_count: 988,
    incomplete_results: false,
    items: [
      {
        number: 326,
        title: "Support multiple accounts",
        html_url: "https://github.com/cli/cli/issues/326",
        reactions: { url: "…", total_count: 418, "+1": 347, heart: 71 },
        updated_at: "2026-07-01T00:00:00Z",
        comments: 2,
        created_at: "2026-06-01T00:00:00Z",
        user: { login: "octocat", id: 583231 },
        labels: [{ id: 1, name: "enhancement", color: "a2eeef", description: "…" }],
        state: "open",
      },
    ],
  })
  const { items, total } = parseSearchJson(raw, "issues")
  assert.equal(total, 988)
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    kind: "issue",
    number: 326,
    title: "Support multiple accounts",
    url: "https://github.com/cli/cli/issues/326",
    reactions: 418,
    updatedAt: "2026-07-01T00:00:00Z",
    labels: [{ name: "enhancement", color: "a2eeef" }],
    comments: 2,
    createdAt: "2026-06-01T00:00:00Z",
    author: "octocat",
    // Uppercased, so rows keep the casing the picker's StateIcon has always been handed.
    state: "OPEN",
  })
})

test("parseSearchJson: prs — kind='pr', draft→isDraft, and NO comment badge", () => {
  const raw = JSON.stringify({
    total_count: 2,
    items: [
      {
        number: 13844,
        title: "perf(status): O(1) map lookup",
        html_url: "https://github.com/cli/cli/pull/13844",
        reactions: { total_count: 0 },
        updated_at: "2026-07-10T15:01:40Z",
        // The search API returns a comment count for PRs; the PR row deliberately doesn't show one.
        comments: 7,
        state: "open",
        draft: true,
        pull_request: { url: "…" },
      },
    ],
  })
  const { items } = parseSearchJson(raw, "prs")
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "pr")
  assert.equal(items[0].number, 13844)
  assert.equal(items[0].reactions, 0)
  assert.equal(items[0].comments, undefined)
  assert.equal(items[0].isDraft, true)
})

test("parseSearchJson: skips rows with a bad/missing number; keeps valid ones", () => {
  const raw = JSON.stringify({
    total_count: 4,
    items: [
      { title: "no number" },
      { number: 0, title: "zero" },
      { number: -5, title: "negative" },
      { number: 7, title: "good", html_url: "u", updated_at: "t" },
    ],
  })
  const { items } = parseSearchJson(raw, "issues")
  assert.equal(items.length, 1)
  assert.equal(items[0].number, 7)
})

test("parseSearchJson: unparseable / wrong shape → empty page (never throws)", () => {
  assert.deepEqual(parseSearchJson("not json", "issues"), { items: [], total: 0 })
  assert.deepEqual(parseSearchJson("{}", "issues"), { items: [], total: 0 })
  assert.deepEqual(parseSearchJson("42", "prs"), { items: [], total: 0 })
  // A bare ARRAY is the OLD `gh issue list` shape — it must not be mistaken for a page of results.
  assert.deepEqual(parseSearchJson("[{\"number\":1}]", "issues"), { items: [], total: 0 })
})

test("parseSearchJson: missing string fields default to ''; a missing total falls back to the row count", () => {
  const { items, total } = parseSearchJson(JSON.stringify({ items: [{ number: 3 }, { number: 4 }] }), "issues")
  assert.equal(total, 2)
  assert.equal(items[0].title, "")
  assert.equal(items[0].url, "")
  assert.equal(items[0].updatedAt, "")
  assert.equal(items[0].reactions, 0)
})

// ---- truncateBody ----

test("truncateBody: short body passes through unchanged", () => {
  assert.equal(truncateBody("hello", 5, "issue"), "hello")
})

test("truncateBody: long body is capped with a pointer to the full item", () => {
  const big = "x".repeat(20_000)
  const outIssue = truncateBody(big, 42, "issue")
  assert.ok(outIssue.length < big.length)
  assert.ok(outIssue.includes("[truncated — read full via `gh issue view 42`]"))
  const outPr = truncateBody(big, 99, "pr")
  assert.ok(outPr.includes("[truncated — read full via `gh pr view 99`]"))
})

// ---- prompt templating (renderGithubPrompt) ----

const issue: HydratedIssue = {
  number: 326,
  title: "Support multiple accounts",
  body: "When I switch accounts the token is wrong.",
  url: "https://github.com/cli/cli/issues/326",
  labels: ["enhancement", "auth"],
}

test("renderGithubPrompt: substitutes all tokens + prepends the THREAD tag", () => {
  const tmpl = "Repo {repo} · Issue #{n}: {title}\nURL: {url}\nLabels: {labels}\n--\n{body}"
  const p = renderGithubPrompt(tmpl, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  assert.ok(p.startsWith("THREAD: investigate-cli-cli-326\n\n"))
  assert.ok(p.includes("Repo cli/cli · Issue #326: Support multiple accounts"))
  assert.ok(p.includes("URL: https://github.com/cli/cli/issues/326"))
  assert.ok(p.includes("Labels: enhancement, auth"))
  assert.ok(p.includes("When I switch accounts the token is wrong."))
})

test("renderGithubPrompt: generated compact lead precedes an exact UI boundary; full template remains below it", () => {
  const template = "INTERNAL TEMPLATE\nRepo={repo}\nBody={body}\n<!-- ordinary-custom-comment -->"
  const p = renderGithubPrompt(template, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  const marker = `\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\n`
  const cut = p.indexOf(marker)
  assert.notEqual(cut, -1)
  assert.equal(
    p.slice(0, cut),
    "THREAD: investigate-cli-cli-326\n\nInvestigate this issue and make recommendations\n\nIssue #326: Support multiple accounts\nRepository: cli/cli\nURL: https://github.com/cli/cli/issues/326",
  )
  assert.equal(
    p.slice(cut + marker.length),
    "INTERNAL TEMPLATE\nRepo=cli/cli\nBody=When I switch accounts the token is wrong.\n<!-- ordinary-custom-comment -->",
  )
  assert.equal(p.split(GITHUB_DISPATCH_UI_BOUNDARY).length - 1, 1)
})

test("renderGithubPrompt: empty labels render 'none'", () => {
  const p = renderGithubPrompt("Labels: {labels}", "cli/cli", { ...issue, labels: [] }, "s", "issue")
  assert.ok(p.includes("Labels: none"))
})

test("renderGithubPrompt: oversized body is truncated (kind-aware pointer)", () => {
  const pIssue = renderGithubPrompt("{body}", "cli/cli", { ...issue, body: "y".repeat(20_000) }, "s", "issue")
  assert.ok(pIssue.includes("[truncated — read full via `gh issue view 326`]"))
  const pPr = renderGithubPrompt("{body}", "cli/cli", { ...issue, number: 99, body: "y".repeat(20_000) }, "s", "pr")
  assert.ok(pPr.includes("[truncated — read full via `gh pr view 99`]"))
})

test("renderGithubPrompt: single-pass — a {token} INSIDE item content is NOT re-expanded (no injection)", () => {
  // A hostile body/title containing a placeholder must appear verbatim, never re-substituted.
  const evil = { ...issue, title: "{repo}", body: "leak {url} {n} {labels}" }
  const p = renderGithubPrompt("T={title}\nB={body}", "cli/cli", evil, "s", "issue")
  assert.ok(p.includes("T={repo}")) // title's literal "{repo}" survives, not re-expanded to cli/cli
  assert.ok(p.includes("B=leak {url} {n} {labels}")) // body placeholders survive verbatim
})

test("renderGithubPrompt: unknown {placeholder} in the template is left verbatim", () => {
  const p = renderGithubPrompt("known {repo} unknown {frobnicate}", "cli/cli", issue, "s", "issue")
  assert.ok(p.includes("known cli/cli unknown {frobnicate}"))
})

// ONE template now serves both kinds, so the guard is that it branches in PROSE and hands the worker
// the read commands for BOTH — a merged default that only knew how to read an issue would silently
// under-serve every PR dispatched from the same picker.
test("DEFAULT_GITHUB_PROMPT: classifies, then branches on bug / feature / PR / docs", () => {
  assert.ok(/classify/i.test(DEFAULT_GITHUB_PROMPT))
  assert.ok(/if it is a BUG REPORT/i.test(DEFAULT_GITHUB_PROMPT))
  assert.ok(/if it is a FEATURE REQUEST/i.test(DEFAULT_GITHUB_PROMPT))
  assert.ok(/if it is a PR/i.test(DEFAULT_GITHUB_PROMPT))
  assert.ok(/if it is a DOCS CHANGE/i.test(DEFAULT_GITHUB_PROMPT))
  assert.ok(/reproduce/i.test(DEFAULT_GITHUB_PROMPT))
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("public API / UX surface"))
  // Both kinds' read commands, because either kind can arrive under this one template.
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("gh issue view {n} -R {repo}"))
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("gh pr view {n} -R {repo}"))
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("gh pr diff {n} -R {repo}"))
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("gh pr checks {n} -R {repo}"))
  // The default is a TEMPLATE: it carries {token}s and NOT the THREAD tag (the server prepends it).
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("{repo}") && DEFAULT_GITHUB_PROMPT.includes("{n}"))
  assert.ok(!DEFAULT_GITHUB_PROMPT.includes("THREAD:"))
})

// This copy shipped with four defects the maintainer asked to correct on 2026-08-16 (they had been kept
// verbatim the day before, under the paste-exactly rule). It is user-visible in the Settings box and in
// every dispatched worker's first message, so the corrections get a guard rather than trust.
test("DEFAULT_GITHUB_PROMPT: the shipped copy stays clean", () => {
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("Be thoughtful, thorough, and dubious"))
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("Trace the impact of the changes"))
  assert.ok(DEFAULT_GITHUB_PROMPT.includes("Body + thread (PRs):"))
  assert.ok(!/\btheads\b/.test(DEFAULT_GITHUB_PROMPT))
  assert.ok(!/\bthoroug\b/.test(DEFAULT_GITHUB_PROMPT))
  // No doubled space anywhere: the textarea soft-wraps, so a stray one shows up as a gap mid-sentence.
  assert.equal(DEFAULT_GITHUB_PROMPT.match(/\S {2,}\S/g), null)
})

// The shipped default is shaped so a user can rewrite the INSTRUCTIONS without touching the template
// tags: prose paragraphs carrying no tokens at all, then a trailing metadata block that carries every
// one of them. This test is the guard on that split — a {token} creeping up into the prose is exactly
// the regression it exists to catch.
test("the default keeps every {token} in the trailing metadata block, none in the instructions", () => {
  const [instructions, metadata, ...rest] = DEFAULT_GITHUB_PROMPT.split("\n\n---\n\n")
  assert.equal(rest.length, 0, "exactly one metadata block")
  assert.ok(metadata, "has a trailing metadata block")
  assert.equal(instructions.match(/\{(repo|n|title|url|labels|body)\}/g), null, "instructions are token-free")
  // Each PARAGRAPH is one unwrapped line: the Settings textarea soft-wraps, so a hard newline at some
  // source column would render ragged in the box the user edits it in. Blank lines between paragraphs
  // are structural, so the check is per-paragraph rather than "no newline at all".
  for (const [i, para] of instructions.split("\n\n").entries()) {
    assert.ok(!para.includes("\n"), `instruction paragraph ${i + 1} is a single unwrapped line`)
    assert.ok(para.trim().length > 0, `instruction paragraph ${i + 1} is not blank`)
  }
  // Every token the default uses lives in the block. {body} is the deliberate exception: the picker is
  // gated on an installed + authed gh, so the block hands the worker the `gh … view` command instead of
  // a truncatable copy of the text.
  for (const token of PROMPT_TOKENS.filter((t) => t !== "body")) {
    assert.ok(metadata.includes(`{${token}}`), `metadata block carries {${token}}`)
  }
  assert.ok(!DEFAULT_GITHUB_PROMPT.includes("{body}"), "default must not inline the body")
})

test("DEFAULT_GITHUB_PROMPT renders into a real issue prompt (round-trip through renderGithubPrompt)", () => {
  const p = renderGithubPrompt(DEFAULT_GITHUB_PROMPT, "cli/cli", issue, "investigate-cli-cli-326", "issue")
  assert.ok(p.startsWith("THREAD: investigate-cli-cli-326\n\n"))
  assert.ok(p.includes("Issue #326: Support multiple accounts"))
  assert.ok(p.includes("gh issue view 326 -R cli/cli --comments"))
  assert.ok(!p.includes("When I switch accounts the token is wrong.")) // body fetched, not inlined
  assert.ok(!p.includes("{repo}") && !p.includes("{n}")) // every token filled
})

const pr: HydratedPr = {
  number: 13844,
  title: "perf(status): O(1) map lookup",
  body: "Replaces the O(n) scan with a map.",
  url: "https://github.com/cli/cli/pull/13844",
  labels: ["external"],
  files: 2,
}

test("DEFAULT_GITHUB_PROMPT renders into a real PR prompt (diff/checks by number)", () => {
  const p = renderGithubPrompt(DEFAULT_GITHUB_PROMPT, "cli/cli", pr, "review-cli-cli-13844", "pr")
  assert.ok(p.startsWith("THREAD: review-cli-cli-13844\n\n"))
  assert.ok(p.includes("PR #13844: perf(status): O(1) map lookup")) // the generated lead names the kind
  // …and the merged template's own heading does not CONTRADICT it. One template serves both kinds, so
  // its heading reads "Issue/PR"; a bare "Issue #N" above a pull request is what this pins against.
  assert.ok(p.includes("Issue/PR #13844: perf(status): O(1) map lookup"))
  assert.ok(!/^Issue #13844/m.test(p))
  assert.ok(p.includes("gh pr view 13844 -R cli/cli --comments"))
  assert.ok(p.includes("gh pr diff 13844 -R cli/cli"))
  assert.ok(p.includes("gh pr checks 13844 -R cli/cli"))
  assert.ok(!p.includes("Replaces the O(n) scan with a map.")) // description fetched, not inlined
  assert.ok(!p.includes("{repo}") && !p.includes("{n}")) // every token filled
})

// ---- linked closing PRs ----

function linkNode(number: number, state: string, isDraft = false) {
  return { number, url: `https://github.com/cli/cli/pull/${number}`, state, isDraft }
}

test("summarizeLinkedPrs: an open link is the primary over a merged one (work in flight is the signal)", () => {
  const prs = summarizeLinkedPrs([linkNode(700, "MERGED"), linkNode(812, "OPEN")])
  assert.deepEqual(prs, { count: 2, number: 812, url: "https://github.com/cli/cli/pull/812", state: "OPEN", isDraft: false })
})

test("summarizeLinkedPrs: a merged link is kept when nothing is open", () => {
  assert.deepEqual(summarizeLinkedPrs([linkNode(616, "MERGED")]), {
    count: 1,
    number: 616,
    url: "https://github.com/cli/cli/pull/616",
    state: "MERGED",
    isDraft: false,
  })
})

test("summarizeLinkedPrs: the badge count is what the row shows — every qualifying link, not just the primary", () => {
  assert.equal(summarizeLinkedPrs([linkNode(1, "OPEN"), linkNode(2, "OPEN"), linkNode(3, "MERGED")])?.count, 3)
})

test("summarizeLinkedPrs: a PR closed WITHOUT merging closes nothing — out of the count AND the pick", () => {
  assert.equal(summarizeLinkedPrs([linkNode(590, "CLOSED")]), undefined)
  // …and a closed one alongside an open one neither shadows it nor inflates the count.
  const prs = summarizeLinkedPrs([linkNode(590, "CLOSED"), linkNode(599, "OPEN")])
  assert.equal(prs?.number, 599)
  assert.equal(prs?.count, 1)
})

test("summarizeLinkedPrs: draft state rides along; empty/malformed → undefined, never throws", () => {
  assert.equal(summarizeLinkedPrs([linkNode(601, "OPEN", true)])?.isDraft, true)
  assert.equal(summarizeLinkedPrs([]), undefined)
  assert.equal(summarizeLinkedPrs(undefined), undefined)
  assert.equal(summarizeLinkedPrs("nope"), undefined)
  assert.equal(summarizeLinkedPrs([{ number: 0, state: "OPEN" }]), undefined) // non-positive number
  assert.equal(summarizeLinkedPrs([{ state: "OPEN" }]), undefined) // no number
})

test("linkedPrQuery: one alias per issue, aliases derived from the number alone", () => {
  const q = linkedPrQuery([562, 610])
  assert.ok(q.includes("i562: issue(number: 562)"))
  assert.ok(q.includes("i610: issue(number: 610)"))
  assert.ok(q.includes("closedByPullRequestsReferences"))
})

test("parseLinkedPrJson: maps each alias to its issue number, skipping issues with no link", () => {
  const raw = JSON.stringify({
    data: {
      repository: {
        i562: { number: 562, closedByPullRequestsReferences: { nodes: [linkNode(599, "OPEN")] } },
        i610: { number: 610, closedByPullRequestsReferences: { nodes: [linkNode(616, "MERGED")] } },
        i605: { number: 605, closedByPullRequestsReferences: { nodes: [] } },
      },
    },
  })
  const map = parseLinkedPrJson(raw)
  assert.equal(map.size, 2)
  assert.equal(map.get(562)?.number, 599)
  assert.equal(map.get(610)?.state, "MERGED")
  assert.equal(map.get(605), undefined)
})

test("parseLinkedPrJson: malformed body / null alias / error payload → empty map, never throws", () => {
  assert.equal(parseLinkedPrJson("not json").size, 0)
  assert.equal(parseLinkedPrJson(JSON.stringify({ errors: [{ message: "rate limited" }] })).size, 0)
  assert.equal(parseLinkedPrJson(JSON.stringify({ data: { repository: null } })).size, 0)
  assert.equal(parseLinkedPrJson(JSON.stringify({ data: { repository: { i1: null } } })).size, 0)
})

// ---- effectiveTemplate (settings override vs default fallback) ----

test("effectiveTemplate: unset/blank falls back to the shipped default", () => {
  assert.equal(effectiveTemplate(undefined), DEFAULT_GITHUB_PROMPT)
  assert.equal(effectiveTemplate(""), DEFAULT_GITHUB_PROMPT)
  assert.equal(effectiveTemplate("   \n\t "), DEFAULT_GITHUB_PROMPT) // whitespace-only = unset
})

test("effectiveTemplate: a non-blank override is used verbatim", () => {
  assert.equal(effectiveTemplate("my custom {title}"), "my custom {title}")
})

// ---- ghAuthed: Frizz's OWN credential, never the operator's `gh` sign-in ----
//
// Until 2026-11-04 this gate asked `gh auth status`, so it read whatever account the operator's `gh`
// was signed into. Now it reads only github-credential.ts. The stub `gh` on PATH below answers every
// auth question "signed in" — it stands for the operator's own sign-in — and must change nothing.

const signedInGh = `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "auth token") echo "gho_operator_token"; exit 0 ;;
esac
exit 1
`

async function withFrizzHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "frizz-gh-home-"))
  const bin = mkdtempSync(join(tmpdir(), "gh-stub-"))
  writeFileSync(join(bin, "gh"), signedInGh, { mode: 0o755 })
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME, FRIZZ_GITHUB_TOKEN: process.env.FRIZZ_GITHUB_TOKEN }
  process.env.HOME = home
  process.env.XDG_DATA_HOME = join(home, "data")
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`
  delete process.env.FRIZZ_GITHUB_TOKEN
  resetFrizzRoots()
  resetGithubCredentialMemo()
  try {
    return await run(home)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetFrizzRoots()
    resetGithubCredentialMemo()
    rmSync(home, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
}

const posixOnly = { skip: process.platform === "win32" ? "the stub is a POSIX shell script" : false }

test("ghAuthed: the operator's signed-in `gh` does NOT sign Frizz in", posixOnly, async () => {
  await withFrizzHome(async () => {
    assert.equal(await ghAuthed(), false)
  })
})

test("ghAuthed: a stored Frizz credential signs it in, with no `gh` involved", posixOnly, async () => {
  await withFrizzHome(async () => {
    writeGithubCredential({ kind: "token", token: "github_pat_frizz", login: "frizz-reader", savedAt: 1 })
    assert.equal(await ghAuthed(), true)
  })
})

test("ghAuthed: FRIZZ_GITHUB_TOKEN signs it in", posixOnly, async () => {
  await withFrizzHome(async () => {
    process.env.FRIZZ_GITHUB_TOKEN = "github_pat_env"
    assert.equal(await ghAuthed(), true)
  })
})

// ---- githubRemoteNameWithOwner (the local, no-network half of the same gate) ----

test("githubRemoteNameWithOwner: every spelling git writes a github.com remote in", () => {
  const expected = "colinhacks/frizz"
  assert.equal(githubRemoteNameWithOwner("git@github.com:colinhacks/frizz.git"), expected)
  assert.equal(githubRemoteNameWithOwner("git@github.com:colinhacks/frizz"), expected)
  assert.equal(githubRemoteNameWithOwner("ssh://git@github.com/colinhacks/frizz.git"), expected)
  assert.equal(githubRemoteNameWithOwner("https://github.com/colinhacks/frizz.git"), expected)
  assert.equal(githubRemoteNameWithOwner("https://github.com/colinhacks/frizz"), expected)
  assert.equal(githubRemoteNameWithOwner("https://user@github.com/colinhacks/frizz.git"), expected)
  assert.equal(githubRemoteNameWithOwner("https://github.com/colinhacks/frizz/"), expected)
  assert.equal(githubRemoteNameWithOwner("  git@github.com:colinhacks/frizz.git\n"), expected) // trailing newline from git
  assert.equal(githubRemoteNameWithOwner("git@GitHub.com:colinhacks/frizz.git"), expected) // host is case-insensitive
})

test("githubRemoteNameWithOwner: a non-github host is not a GitHub repo — including hosts that merely CONTAIN github.com", () => {
  // The whole point of this probe is to open a feature door, so a near-miss host must read as null
  // rather than as github.com.
  assert.equal(githubRemoteNameWithOwner("git@gitlab.com:colinhacks/frizz.git"), null)
  assert.equal(githubRemoteNameWithOwner("https://bitbucket.org/colinhacks/frizz.git"), null)
  assert.equal(githubRemoteNameWithOwner("https://github.com.evil.com/colinhacks/frizz.git"), null)
  assert.equal(githubRemoteNameWithOwner("https://evil.com/github.com/colinhacks/frizz"), null)
  assert.equal(githubRemoteNameWithOwner("git@github.enterprise.co:colinhacks/frizz.git"), null)
})

test("githubRemoteNameWithOwner: anything that is not exactly owner/repo → null, never throws", () => {
  assert.equal(githubRemoteNameWithOwner(""), null)
  assert.equal(githubRemoteNameWithOwner("   "), null)
  assert.equal(githubRemoteNameWithOwner("not a url"), null)
  assert.equal(githubRemoteNameWithOwner("https://github.com/colinhacks"), null) // owner only
  assert.equal(githubRemoteNameWithOwner("https://github.com/a/b/c"), null) // too deep
  assert.equal(githubRemoteNameWithOwner("https://github.com/"), null)
  assert.equal(githubRemoteNameWithOwner("/Users/colinmcd94/some/local/path"), null)
})

// The regression this whole fallback exists for: gh cannot reach the network, so `gh repo view` fails
// exactly as it does for a gitlab origin — and the trigger's `inRepo && authed` gate hid the feature.
// Run against a REAL git repo with a REAL remote, because the seam under test is the subprocess.
test("gitGithubRemote: reads a real repo's origin with no network and no gh at all", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-remote-"))
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
    run(["init", "-q"])
    run(["remote", "add", "origin", "git@github.com:colinhacks/frizz.git"])
    assert.equal(await gitGithubRemote(dir), "colinhacks/frizz")
    // Negative control: the same real probe on the same real repo must FAIL when origin is not GitHub,
    // otherwise the test above proves nothing about the host check.
    run(["remote", "set-url", "origin", "git@gitlab.com:colinhacks/frizz.git"])
    assert.equal(await gitGithubRemote(dir), null)
    // …and a repo with no remote at all.
    run(["remote", "remove", "origin"])
    assert.equal(await gitGithubRemote(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
