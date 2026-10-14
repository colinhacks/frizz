import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { MARKDOWN_OPTIONS } from "./markdown.ts"
import { githubRepoFor, setGithubRepo, setProjectGithubRepo, subscribeGithubRepo, withGithubRepo } from "./githubAutolink.ts"

// The app's REAL marked configuration, driven straight — mdToHtml's sanitizer needs a DOM, so what is
// exercised here is the tokenizing half (the sanitizer's treatment of the anchors this mints is the
// same allowlist path every other link already takes, pinned in markdownSanitizer.e2e.test.ts).
const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => marked.parseInline(md, { async: false }) as string
const renderBlock = (md: string) => (marked.parse(md, { async: false }) as string).trim()

const REPO = "colinhacks/frizz"
const issue = (n: number, repo = REPO) => `<a href="https://github.com/${repo}/issues/${n}" title="${repo}#${n}">#${n}</a>`
const commit = (sha: string, repo = REPO) => `<a href="https://github.com/${repo}/commit/${sha}" title="${repo}@${sha}">${sha}</a>`

before(() => setGithubRepo(REPO))
after(() => setGithubRepo(null))

test("an issue number becomes a link to this project's repo", () => {
  assert.equal(render("fixed in #123"), `fixed in ${issue(123)}`)
  assert.equal(render("#1 and #4207 both"), `${issue(1)} and ${issue(4207)} both`)
})

test("a cross-repo reference keeps its own owner/repo", () => {
  assert.equal(render("see nubjs/nub#587"),
    `see <a href="https://github.com/nubjs/nub/issues/587" title="nubjs/nub#587">nubjs/nub#587</a>`)
})

test("a bare commit hash becomes a commit link, in every length git prints", () => {
  assert.equal(render("landed as 749a37b"), `landed as ${commit("749a37b")}`)
  assert.equal(render("landed as 2acb94a1"), `landed as ${commit("2acb94a1")}`)
  const full = "2acb94a1b0c3d4e5f60718293a4b5c6d7e8f9012"
  assert.equal(render(`landed as ${full}`), `landed as ${commit(full)}`)
})

test("a cross-repo commit keeps its own owner/repo", () => {
  assert.equal(render("nubjs/nub@749a37b"),
    `<a href="https://github.com/nubjs/nub/commit/749a37b" title="nubjs/nub@749a37b">nubjs/nub@749a37b</a>`)
})

// The whole point of rewriting tokens rather than the source: an author's literal bytes survive.
test("code stays literal — fenced, indented and inline", () => {
  assert.equal(render("`#123` and `749a37b`"), "<code>#123</code> and <code>749a37b</code>")
  assert.ok(renderBlock("```\n#123 749a37b\n```").includes("#123 749a37b"))
  assert.ok(!renderBlock("```\n#123\n```").includes("<a "))
})

test("a reference inside link text does not mint a nested anchor", () => {
  assert.equal(render("[see #12](https://example.com/x)"),
    `<a href="https://example.com/x">see #12</a>`)
})

test("a github.com URL an author already wrote is left as one link", () => {
  const url = "https://github.com/colinhacks/frizz/commit/749a37b"
  assert.equal(render(url), `<a href="${url}">${url}</a>`)
})

// Each of these was a live false positive the boundary/shape rules exist to kill.
test("things that merely LOOK like references are left alone", () => {
  // CSS colours: `#` is not a boundary character, and an issue number has no leading zero.
  assert.equal(render("bg #0d0e10 over #fff and #000000"), "bg #0d0e10 over #fff and #000000")
  // A UUID's segments are hex, and its last one is 12 characters long.
  assert.equal(render("da3513c7-634b-489d-8cf5-f27a7ac7aa70"), "da3513c7-634b-489d-8cf5-f27a7ac7aa70")
  // Hex with no a-f letter is a date or a byte count far more often than it is a hash.
  assert.equal(render("20260813 and 1234567 bytes"), "20260813 and 1234567 bytes")
  // Hex with no digit is an English word.
  assert.equal(render("the wall was defaced"), "the wall was defaced")
  // A sha256 is longer than any commit hash; it must match NOTHING, not its first 40 characters.
  const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  assert.equal(render(sha256), sha256)
  // Mid-word and mid-path runs are not references.
  assert.equal(render("packages/web/src#1 and v1-749a37b"), "packages/web/src#1 and v1-749a37b")
  // A heading is a block construct, not an issue number.
  assert.equal(renderBlock("# 123"), "<h1>123</h1>")
})

test("references survive inside emphasis, lists and tables", () => {
  assert.equal(render("**#123**"), `<strong>${issue(123)}</strong>`)
  assert.ok(renderBlock("- fixes #123").includes(issue(123)))
  assert.ok(renderBlock("| a | b |\n| --- | --- |\n| #123 | 749a37b |").includes(issue(123)))
  assert.ok(renderBlock("| ref | #123 |\n| sha | 749a37b |").includes(commit("749a37b")))
  assert.ok(renderBlock("- [x] shipped #123").includes(issue(123)))
})

test("nothing is linked when the project is not a github.com repo", () => {
  setGithubRepo(null)
  try {
    assert.equal(render("fixed in #123 by 749a37b"), "fixed in #123 by 749a37b")
    // Even the self-contained cross-repo forms stay off, so the feature is one predictable switch.
    assert.equal(render("nubjs/nub#587"), "nubjs/nub#587")
  } finally {
    setGithubRepo(REPO)
  }
})

// THE CONSOLE. The page names no project there, so the page repo is null — and until each surface asked
// for its OWN project's repo, every reference on the Console rendered as plain text.
test("a Console surface links against its own project's repo, not the page's", () => {
  setGithubRepo(null)
  setProjectGithubRepo("app", "acme/app")
  setProjectGithubRepo("nub", "nubjs/nub")
  try {
    const renderIn = (project: string | undefined, md: string) => withGithubRepo(githubRepoFor(project), () => render(md))
    assert.equal(renderIn("app", "#6372"), issue(6372, "acme/app"))
    assert.equal(renderIn("nub", "landed as 749a37b"), `landed as ${commit("749a37b", "nubjs/nub")}`)
    // The reported case: a fully qualified reference in a Console card.
    assert.equal(renderIn("app", "acme/app#6341"),
      `<a href="https://github.com/acme/app/issues/6341" title="acme/app#6341">acme/app#6341</a>`)
    // A project with no github.com repo, and a surface with no project, fall back to the page: nothing.
    assert.equal(renderIn("gitlab-project", "#12"), "#12")
    assert.equal(renderIn(undefined, "#12"), "#12")
    // The override lasts exactly one render.
    assert.equal(render("#12"), "#12")
  } finally {
    setProjectGithubRepo("app", null)
    setProjectGithubRepo("nub", null)
    setGithubRepo(REPO)
  }
})

test("a project's page is untouched by the Console's repos", () => {
  setProjectGithubRepo("nub", "nubjs/nub")
  try {
    assert.equal(githubRepoFor(undefined), REPO)
    assert.equal(render("#123"), issue(123))
  } finally {
    setProjectGithubRepo("nub", null)
  }
})

test("a Console project's repo arriving or leaving re-renders its prose", () => {
  let notified = 0
  const unsubscribe = subscribeGithubRepo(() => notified++)
  try {
    setProjectGithubRepo("nub", "nubjs/nub")
    setProjectGithubRepo("nub", "nubjs/nub")
    assert.equal(notified, 1, "the same repo again is not a change")
    setProjectGithubRepo("nub", null)
    assert.equal(notified, 2)
    assert.equal(githubRepoFor("nub"), REPO, "a project that left falls back to the page")
  } finally {
    unsubscribe()
  }
})
