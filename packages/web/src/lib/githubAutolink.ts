import type { Token, Tokens } from "marked"

// GitHub-style autolinking of the two references agents and humans write constantly in prose but
// almost never spell as a URL: an issue/PR number (`#123`, `owner/repo#123`) and a commit hash
// (`749a37b`, `owner/repo@749a37b`). GitHub does this inside issues and PRs; Frizz's chat is where
// the same shorthand is written, and it was rendering as inert text.
//
// WHY A TOKEN REWRITE AND NOT A REGEX OVER THE MARKDOWN. Running this over the raw source would
// rewrite `#123` inside a fenced block, an inline `code` span, a link destination and a URL — all
// places where the author's bytes must survive verbatim, and where a hex-looking run is most likely
// NOT a commit. Rewriting TOKENS instead means code is literal by construction (marked never
// re-tokenizes it), and the traversal below simply declines to descend into a link or an image, so a
// `[see #12](…)` label can never mint an anchor inside an anchor.
//
// It runs from marked's `processAllTokens` hook rather than `walkTokens` because the hook is handed
// the ROOT array. `walkTokens` only ever hands you a token, so a top-level text token — which is the
// whole document on the `parseInline` path (answer chips, the awaiting caption) — has no parent whose
// children could be spliced, and that surface would have been silently skipped.

// NOT lib/githubRef.ts, and the overlap is deliberate. That one turns a ref a WATCHER already told us
// is a pull request into `/pull/N`; this one has only prose to go on, where a bare `#123` is an issue
// more often than not — so it builds `/issues/N`, which GitHub redirects to the PR when the number
// turns out to be one. Same site, different question, opposite default.
const GITHUB = "https://github.com"

// "owner/repo" for the project this page is showing, or null when it is not a github.com repo.
//
// A module-level value, set from the board snapshot (store.ts) rather than passed through every
// `mdToHtml` call: there are a dozen call sites, each memoizing on its own markdown string, and
// threading an extra argument through all of them buys nothing — a page shows one project at a time,
// and a switch tears down every markdown-rendering surface with it (resetProjectState nulls the board
// and the drawer stack). See `setGithubRepo` for why the board is the right source.
let repo: string | null = null
const listeners = new Set<() => void>()

/**
 * Point the autolinker at this page's project. Called from the board's own door (setBoard/seedBoard).
 *
 * IT MUST NOTIFY, and that is not belt-and-braces. Setting the value from the board looks early enough
 * — the board is the payload the threads themselves come from — but it is NOT: a thread's TRANSCRIPT is
 * its own query, and it resolved first. Measured 2026-08-13 against a real stack, before the
 * subscription existed: the module held "colinhacks/frizz" and re-rendering the same markdown by hand
 * produced the anchors, while the transcript on screen had none — HTML memoized on the markdown string
 * alone, built when the repo was still null, and nothing would ever invalidate it. useMarkdownHtml
 * (lib/useMarkdown.ts) subscribes here so the value is a real render input.
 */
export function setGithubRepo(next: string | null | undefined): void {
  const value = next ?? null
  if (value === repo) return
  repo = value
  for (const listener of listeners) listener()
}

/** The repo the autolinker is pointed at — the `getSnapshot` half of the subscription. */
export function githubRepoForLinks(): string | null {
  return repo
}

export function subscribeGithubRepo(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// One repo path segment: GitHub's own owner/name character set.
const SEG = "[A-Za-z0-9][A-Za-z0-9._-]*"

// A github.com issue/PR/commit destination → the canonical hovercard key (`owner/repo#123`,
// `owner/repo@<sha>`), or null for anything else on the site (a tree, a release, the repo root).
//
// It reads the HREF rather than the anchor's `title`, and that is deliberate: the same rule then
// covers a reference the AUTOLINKER minted and a full URL the author simply pasted or wrote as
// `[the fix](https://github.com/…/pull/12)`, which are the same thing to a reader. `/issues/N` and
// `/pull/N` collapse to one `#N` key because the API resolves either from the number alone — which is
// also why the autolinker can mint `/issues/N` for a ref that turns out to be a PR.
const GITHUB_URL = new RegExp(
  `^https://github\\.com/(${SEG})/(${SEG})/(?:(issues|pull)/([1-9]\\d{0,9})|commit/([0-9a-f]{7,40}))(?:[/?#].*)?$`,
  "i",
)

export function githubRefFromUrl(href: string | null | undefined): string | null {
  if (!href) return null
  const match = GITHUB_URL.exec(href.trim())
  if (!match) return null
  const [, owner, name, , number, sha] = match
  return number ? `${owner}/${name}#${number}` : `${owner}/${name}@${sha.toLowerCase()}`
}

// The three shapes, tried in that order against a boundary-anchored position.
//
// The LEADING class is what keeps a reference out of the middle of a word or a path. `#` is excluded
// so `##123` stays prose and — more importantly — so a CSS colour like `#0d0e10` can never have its
// tail read as a hash; `/` so `packages/web/src#1` is a path rather than a cross-repo reference; `-`
// so a UUID's segments (`da3513c7-634b-…`) are never mistaken for short hashes; `@` so an
// `owner/repo@sha` that this pattern declines to match cannot have its bare tail linked to the WRONG
// repo. The TRAILING `(?![\w-])` is the same guard from the other side, and is what makes a 64-char
// sha256 match nothing at all rather than matching its first 40 characters.
//
// `[1-9]` opens an issue number because issue numbers have no leading zero — which is also what
// keeps `#000000` and `#0d0e10` out with no colour-specific rule.
const REF = new RegExp(
  "(^|[^\\w#/&@-])(?:" +
    `(${SEG}/${SEG})@([0-9a-f]{7,40})` + // 2,3 — owner/repo@hash
    `|(${SEG}/${SEG})?#([1-9]\\d{0,9})` + // 4,5 — [owner/repo]#123
    "|([0-9a-f]{7,40})" + // 6 — a bare commit hash
  ")(?![\\w-])",
  "g",
)

// A hex run is only treated as a commit when it carries BOTH a digit and an a-f letter.
//
// Neither half is optional, and each kills a whole class of false positive that the length rule alone
// lets through. Without the letter, an 8-digit date (`20260813`) or a byte count is hex and would
// link. Without the digit, so is a 7-letter English word — "defaced" and "effaced" are both spelled
// entirely from a-f. The price is a real short hash that happens to hold no letter or no digit: for 7
// characters that is (10/16)^7 + (6/16)^7 ≈ 3.8%, falling fast with length. That trade is deliberate,
// because the two outcomes are not symmetric — a missed reference renders exactly as it does today,
// while a wrong one sends the reader to a 404 in a real repo.
function isCommitHash(hex: string): boolean {
  return /\d/.test(hex) && /[a-f]/.test(hex)
}

function textToken(text: string): Tokens.Text {
  return { type: "text", raw: text, text }
}

function linkToken(text: string, href: string, title: string): Tokens.Link {
  return { type: "link", raw: text, href, title, text, tokens: [textToken(text)] }
}

/** One reference found in a plain string: where it sits and the link it should become. */
export type GithubRefMatch = { start: number; text: string; href: string; title: string }

/**
 * Every GitHub-style reference in a plain string — the same grammar the markdown path links, exposed
 * for surfaces that render text WITHOUT markdown (the user bubble, lib/plainLinks.ts). Empty when the
 * project is not a github.com repo, the same one predictable switch the token path has.
 */
export function scanGithubRefs(source: string): GithubRefMatch[] {
  if (!repo) return []
  const matches: GithubRefMatch[] = []
  REF.lastIndex = 0
  for (let match = REF.exec(source); match; match = REF.exec(source)) {
    const [whole, boundary, commitRepo, commitHash, issueRepo, issueNumber, bareHash] = match
    const hash = commitHash ?? bareHash
    if (hash && !isCommitHash(hash)) continue
    const href = issueNumber
      ? `${GITHUB}/${issueRepo ?? repo}/issues/${issueNumber}`
      : `${GITHUB}/${commitRepo ?? repo}/commit/${hash}`
    const title = issueNumber
      ? `${issueRepo ?? repo}#${issueNumber}`
      : `${commitRepo ?? repo}@${hash}`
    matches.push({ start: match.index + boundary.length, text: whole.slice(boundary.length), href, title })
  }
  return matches
}

/** The pieces one text token splits into, or null when it holds no reference. */
function splitRefs(source: string): Token[] | null {
  const matches = scanGithubRefs(source)
  if (matches.length === 0) return null
  const pieces: Token[] = []
  let consumed = 0
  for (const { start, text, href, title } of matches) {
    if (start > consumed) pieces.push(textToken(source.slice(consumed, start)))
    pieces.push(linkToken(text, href, title))
    consumed = start + text.length
  }
  if (consumed < source.length) pieces.push(textToken(source.slice(consumed)))
  return pieces
}

// Tokens whose contents are the author's literal bytes (`code`, `codespan`, raw `html`) or already an
// anchor (`link`, `image`). Not descended into at all — the anchor cases are why `[see #12](…)` and a
// bare autolinked URL cannot grow a nested link.
const OPAQUE = new Set(["code", "codespan", "html", "link", "image"])

/**
 * Every child-token array hanging off one token, including the cell arrays a table keeps. Shared with
 * lib/windowsPathEscapes.ts, the other pass that walks the whole tree from `processAllTokens`.
 */
export function childArrays(token: Token): Token[][] {
  const arrays: Token[][] = []
  const any = token as { tokens?: Token[]; items?: Token[]; header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] }
  if (Array.isArray(any.tokens)) arrays.push(any.tokens)
  if (Array.isArray(any.items)) arrays.push(any.items)
  for (const cell of any.header ?? []) if (Array.isArray(cell.tokens)) arrays.push(cell.tokens)
  for (const row of any.rows ?? []) for (const cell of row) if (Array.isArray(cell.tokens)) arrays.push(cell.tokens)
  return arrays
}

/**
 * Rewrite every plain-text token in the tree into text + link tokens. Mutates in place.
 *
 * Walks BACKWARDS so a splice cannot disturb the indices still to be visited. A `text` token that
 * carries its own `tokens` is a container (a loose list item's block text), so it is descended into
 * rather than split — splitting it would drop the children it renders from.
 */
export function linkifyGithubRefs(tokens: Token[]): void {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]
    if (OPAQUE.has(token.type)) continue
    const children = childArrays(token)
    for (const array of children) linkifyGithubRefs(array)
    if (token.type !== "text" || children.length > 0) continue
    const pieces = splitRefs((token as Tokens.Text).text)
    if (pieces) tokens.splice(i, 1, ...pieces)
  }
}
