import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { plainLinkSegments, type PlainLinkSegment } from "./plainLinks.ts"
import { setGithubRepo } from "./githubAutolink.ts"

const REPO = "colinhacks/frizz"
before(() => setGithubRepo(REPO))
after(() => setGithubRepo(null))

const links = (segments: PlainLinkSegment[]) => segments.filter((s) => s.kind === "link")
const joined = (segments: PlainLinkSegment[]) => segments.map((s) => s.text).join("")

test("a pasted URL in a plain sentence becomes one link (the user-bubble case)", () => {
  const text = "We've already closed this...\nhttps://github.com/colinhacks/zod/pull/6013\n\nWhy don't we look for others?"
  const segments = plainLinkSegments(text)
  assert.deepEqual(links(segments), [{
    kind: "link",
    text: "https://github.com/colinhacks/zod/pull/6013",
    href: "https://github.com/colinhacks/zod/pull/6013",
    ghRef: "colinhacks/zod#6013",
  }])
  assert.equal(joined(segments), text)
})

test("trailing sentence punctuation stays prose, not part of the URL", () => {
  for (const tail of [".", ",", "?", "!", ":", ";", '."']) {
    const segments = plainLinkSegments(`see https://example.com/a${tail} next`)
    assert.equal(links(segments)[0]?.href, "https://example.com/a", `tail ${JSON.stringify(tail)}`)
    assert.equal(joined(segments), `see https://example.com/a${tail} next`)
  }
})

test("a wrapping parenthesis is shed; a balanced one inside the path is kept", () => {
  assert.equal(links(plainLinkSegments("(https://example.com/a) yes"))[0]?.href, "https://example.com/a")
  const wiki = "https://en.wikipedia.org/wiki/Foo_(bar)"
  assert.equal(links(plainLinkSegments(`read ${wiki} today`))[0]?.href, wiki)
})

test("a www URL links with an http scheme; a lone www label does not link", () => {
  const segments = plainLinkSegments("try www.example.com first")
  assert.deepEqual(links(segments), [{ kind: "link", text: "www.example.com", href: "http://www.example.com", ghRef: null }])
  // A full domain is required — `www.` plus ONE label is likelier prose than a link.
  assert.equal(links(plainLinkSegments("the www.local host")).length, 0)
  assert.equal(links(plainLinkSegments("the www. prefix")).length, 0)
  assert.equal(links(plainLinkSegments("a path/www.example.com stays a path")).length, 0)
  assert.equal(links(plainLinkSegments("en.www.example.com is mid-domain")).length, 0)
})

test("a bare scheme with nothing linkable after it stays prose", () => {
  assert.equal(links(plainLinkSegments("the https:// prefix broke")).length, 0)
  assert.equal(links(plainLinkSegments("https://. hmm")).length, 0)
})

test("GitHub shorthand outside URLs links exactly as it does in markdown prose", () => {
  const segments = plainLinkSegments("fixed in #123 by 749a37b, see nubjs/nub#587")
  assert.deepEqual(links(segments), [
    { kind: "link", text: "#123", href: `https://github.com/${REPO}/issues/123`, title: `${REPO}#123`, ghRef: `${REPO}#123` },
    { kind: "link", text: "749a37b", href: `https://github.com/${REPO}/commit/749a37b`, title: `${REPO}@749a37b`, ghRef: `${REPO}@749a37b` },
    { kind: "link", text: "nubjs/nub#587", href: "https://github.com/nubjs/nub/issues/587", title: "nubjs/nub#587", ghRef: "nubjs/nub#587" },
  ])
  assert.equal(joined(segments), "fixed in #123 by 749a37b, see nubjs/nub#587")
})

test("a hex run or #fragment inside a URL is the URL's, never a second link", () => {
  const url = "https://example.com/blob/749a37b/x#123"
  const segments = plainLinkSegments(`see ${url} there`)
  assert.equal(links(segments).length, 1)
  assert.equal(links(segments)[0]?.href, url)
})

test("a reference in the tail a URL's trim gave back is still linked", () => {
  const segments = plainLinkSegments("https://example.com/a, then #123")
  assert.equal(links(segments).length, 2)
  assert.equal(links(segments)[1]?.text, "#123")
})

test("URLs never depend on the repo; shorthand switches off without one", () => {
  setGithubRepo(null)
  try {
    const segments = plainLinkSegments("see https://example.com and #123")
    assert.deepEqual(links(segments), [{ kind: "link", text: "https://example.com", href: "https://example.com", ghRef: null }])
  } finally {
    setGithubRepo(REPO)
  }
})

test("plain prose comes back as one text segment, byte-for-byte", () => {
  const text = "no links here.\njust words — and #0d0e10 the colour."
  assert.deepEqual(plainLinkSegments(text), [{ kind: "text", text }])
})

test("a surface's own repo outranks the page's", () => {
  const segments = plainLinkSegments("fixed in #12 by 749a37b", "nubjs/nub")
  assert.deepEqual(links(segments).map((s) => s.kind === "link" && s.href), [
    "https://github.com/nubjs/nub/issues/12",
    "https://github.com/nubjs/nub/commit/749a37b",
  ])
  assert.equal(links(plainLinkSegments("fixed in #12", null)).length, 0, "a surface whose project has no github.com repo links nothing")
})
