import { githubRefFromUrl, scanGithubRefs } from "./githubAutolink.ts"

// Linkification for text that renders WITHOUT markdown — the user chat bubble above all. A human's
// message is verbatim (whitespace-pre-wrap, no parser), so a pasted `https://github.com/...` URL was
// the one link-shaped thing in the transcript that stayed inert text while the agent prose around it
// was clickable. This splits a plain string into text and link segments; the component that renders
// them (components/LinkifiedText.tsx) keeps every text byte as-is, so nothing about the verbatim
// contract changes — some runs just become anchors.
//
// Two grammars, same as the markdown path: a bare http(s)/www URL (what GFM autolinks), and the
// GitHub shorthand (`#123`, `owner/repo#123`, a commit hash) via scanGithubRefs — one grammar shared
// with the token rewriter in githubAutolink.ts, so a ref means the same thing in both kinds of prose.

export type PlainLinkSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string; title?: string; ghRef: string | null }

// A URL starts at a boundary — never mid-word (`xhttps://`), mid-path (`a/www.b`), or mid-domain
// (`en.www.`) — matching the boundary discipline REF uses in githubAutolink.ts. `www.` needs a real
// domain shape (two labels minimum) or "www.ok" in prose would link; a scheme needs no such guard
// because nobody types `https://` by accident. `<>` and backticks are excluded from the body: they
// are how prose WRAPS a URL, not part of one.
const URL = /(^|[^\w/.@-])(https?:\/\/[^\s<>`]+|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[^\s<>`]*)?)/gi

// Trailing sentence punctuation belongs to the sentence, not the URL — "see https://x.com/a." links
// `/a`, not `/a.`. A closer (`)]}`  ) is stripped only while UNBALANCED, so a Wikipedia-style
// `/Foo_(bar)` keeps its parenthesis while `(https://x.com/a)` sheds the wrapper's.
const TRAILING = new Set([".", ",", ":", ";", "!", "?", "*", "_", "~", "'", '"'])
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const last = url[url.length - 1]
    if (last !== undefined && TRAILING.has(last)) { url = url.slice(0, -1); continue }
    const opener = last !== undefined ? CLOSERS[last] : undefined
    if (opener) {
      let depth = 0
      for (const ch of url) {
        if (ch === opener) depth++
        else if (ch === last) depth--
      }
      if (depth < 0) { url = url.slice(0, -1); continue }
    }
    break
  }
  return url
}

function pushText(segments: PlainLinkSegment[], text: string, githubRepo: string | null | undefined): void {
  if (text === "") return
  // The GitHub shorthand only lives OUTSIDE URLs — a hex run inside a pasted URL's path is a path.
  let consumed = 0
  for (const ref of scanGithubRefs(text, githubRepo)) {
    if (ref.start > consumed) segments.push({ kind: "text", text: text.slice(consumed, ref.start) })
    segments.push({ kind: "link", text: ref.text, href: ref.href, title: ref.title, ghRef: githubRefFromUrl(ref.href) })
    consumed = ref.start + ref.text.length
  }
  if (consumed < text.length) segments.push({ kind: "text", text: text.slice(consumed) })
}

/**
 * Split a plain string into text and link segments. Concatenating every segment's `text` yields the
 * input byte-for-byte — links re-dress runs of the original text, they never rewrite it. `githubRepo`
 * is the repo a `#123` links to (the surface's, from useGithubRepoForLinks); left out, the page's.
 */
export function plainLinkSegments(source: string, githubRepo?: string | null): PlainLinkSegment[] {
  const segments: PlainLinkSegment[] = []
  let consumed = 0
  URL.lastIndex = 0
  for (let match = URL.exec(source); match; match = URL.exec(source)) {
    const [, boundary, body] = match
    const url = trimUrl(body)
    // A degenerate match — a bare scheme with nothing after it ("https:// broke") — is prose.
    if (/^https?:\/\/$/i.test(url) || url === "") continue
    const start = match.index + boundary.length
    // Resume right after the LINKED part: the trimmed-off tail may itself hold a reference.
    URL.lastIndex = start + url.length
    const href = /^www\./i.test(url) ? `http://${url}` : url
    if (start > consumed) pushText(segments, source.slice(consumed, start), githubRepo)
    segments.push({ kind: "link", text: url, href, ghRef: githubRefFromUrl(href) })
    consumed = start + url.length
  }
  if (consumed < source.length) pushText(segments, source.slice(consumed), githubRepo)
  return segments
}
