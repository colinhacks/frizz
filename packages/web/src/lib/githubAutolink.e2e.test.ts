import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin.
//   cd packages/web && nubx vite --port 5199 &
//   FRIZZ_GITHUB_AUTOLINK_E2E_URL=http://127.0.0.1:5199 nub --test src/lib/githubAutolink.e2e.test.ts
const baseUrl = process.env.FRIZZ_GITHUB_AUTOLINK_E2E_URL

// githubAutolink.test.ts drives the token rewrite; this drives the whole shipped path — useMarkdownHtml
// through marked AND the DOM sanitizer — in a real browser, under the timing that broke it.
//
// THE ASSERTION THAT MATTERS IS THE SECOND ONE. The repo lands 250ms after first paint, because that
// is what the running app does (it comes off the board, and a thread's transcript query resolves
// first). An implementation that memoizes rendered HTML on the markdown string alone passes the
// before-check and fails here, which is exactly how the first version of this shipped green unit tests
// while the real app showed no links at all.
test("references linkify when the repo arrives after first render", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.goto(`${baseUrl}/github-autolink-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-case=issue] [data-rendered]")

    const hrefsIn = (id: string) =>
      page.$$eval(`[data-case=${id}] [data-rendered] a`, (anchors) =>
        anchors.map((a) => `${a.textContent} -> ${a.getAttribute("href")}`))

    // Before the repo lands there is nothing to link to, so the prose is plain — the state the app is
    // in for the first beat of every page load.
    assert.deepEqual(await hrefsIn("issue"), [], "no repo yet: nothing may be linked")

    await page.waitForFunction(() => document.querySelectorAll("[data-case=issue] [data-rendered] a").length === 2,
      { timeout: 10_000 })

    assert.deepEqual(await hrefsIn("issue"), [
      "#123 -> https://github.com/colinhacks/frizz/issues/123",
      "#4207 -> https://github.com/colinhacks/frizz/issues/4207",
    ])
    assert.deepEqual(await hrefsIn("cross-repo"), ["nubjs/nub#587 -> https://github.com/nubjs/nub/issues/587"])
    assert.deepEqual(await hrefsIn("commit"), [
      "749a37b -> https://github.com/colinhacks/frizz/commit/749a37b",
      "nubjs/nub@fe2a46c -> https://github.com/nubjs/nub/commit/fe2a46c",
    ])

    // The Console: each card links to its own project's repo, not the page's.
    assert.deepEqual(await hrefsIn("console-app"), [
      "acme/app#6372 -> https://github.com/acme/app/issues/6372",
      "#6341 -> https://github.com/acme/app/issues/6341",
    ])
    assert.deepEqual(await hrefsIn("console-nub"), [
      "#12 -> https://github.com/nubjs/nub/issues/12",
      "749a37b -> https://github.com/nubjs/nub/commit/749a37b",
    ])

    // The author's literal bytes, and no anchor inside an anchor.
    assert.deepEqual(await hrefsIn("code"), [], "a hash inside `code` is not a reference")
    assert.deepEqual(await hrefsIn("link-text"), ["see #12 -> https://example.com/x"])

    // The near-misses: a colour, a UUID's hex segments, an all-digit run, an all-letter hex word.
    for (const id of ["colour", "uuid", "digits"]) {
      assert.deepEqual(await hrefsIn(id), [], `${id}: must stay plain text`)
    }

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
