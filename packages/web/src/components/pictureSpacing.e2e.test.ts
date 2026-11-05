import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the air around a rendered PICTURE. Skipped unless a Vite URL serving the
// fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and
// set FRIZZ_PICTURE_SPACING_E2E_URL to its origin.
//
// The invariant (maintainer 2026-08-11, on an image `Read` with the live shimmer under it: "we need
// better spacing under the screenshots … it's too close"): a picture CARD is a tool-activity EXCEPTION,
// so every spacing predicate used to see "a card" and charge the tight 6px run that binds a batch of
// compact bands together. A picture is not a compact band — measured 6.19px from the frame's bottom
// border to the shimmer's box — so it takes PICTURE_STEP against whatever it neighbours, on both sides,
// while the compact exceptions around it keep their rail.
//
// The picture card is a SendUserFile delivery now. The image `Read` that prompted the rule folds into
// the collapsed digest since 2026-10-03 (maintainer: "No images or screenshots are visible unless you
// make them visible to the user with the light box"), so it is a bare label row and is spaced like one.
//
// Measured in the browser rather than asserted on the tree because this is layout, and because the rule
// is charged in FOUR places (the between-message gap, the working-indicator gap, the seams inside one
// tool band, and the seams between a message's blocks) that must not drift apart.
//
// The picture itself does not have to LOAD: `/local-image` is not served by a plain Vite dev server, so
// the delivery's gallery lists its path as text — and the gap is decided by the tool's `sentImages`
// field, never by whether the bytes arrived. Point the URL at a server that proxies /_frizz to a real stack if
// you want to SEE the frames while the numbers are checked.
const baseUrl = process.env.FRIZZ_PICTURE_SPACING_E2E_URL

const TIGHT = 6
// Two compact rows share one rail, with no gap between them (ChatView ToolRailRows).
const RAIL = 0
const STEP = 14
const PICTURE = 22
// The virtualizer positions rows at fractional offsets, so a measured gap lands within a sub-pixel of
// its constant. Assert the pitch, not the rounding.
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.5, `${what}: expected ~${expected}px, got ${actual}px`)

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  // `flushSync` is the virtualizer's own dev-mode warning on this fixture — it predates this rule and
  // fires identically with the spacing reverted, so it is noise here rather than a signal.
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|local-image|flushSync/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

const fixtureUrl = (query: string) => new URL(`/screenshot-gap-fixture.html${query}`, baseUrl).href

// The gap from the last rendered message row to the runtime-status row. The virtualizer's DOM order is
// not its VISUAL order (rows are absolutely positioned), so the row above the shimmer is the one whose
// bottom edge sits lowest, never `rows[rows.length - 1]`.
async function tailGap(page: import("puppeteer").Page) {
  return page.evaluate(() => {
    const scope = document.querySelector("[data-virtualized-transcript]")
    if (!scope) return { error: "surface not mounted" }
    const rows = [...scope.querySelectorAll("[data-frizz-msg]")]
    const working = scope.querySelector("[data-working-indicator]")
    if (!working || rows.length === 0) return { error: "no live tail" }
    const last = rows.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a))
    return {
      lastRow: last.getAttribute("data-frizz-msg"),
      aboveWorking: Math.round((working.getBoundingClientRect().top - last.getBoundingClientRect().bottom) * 10) / 10,
    }
  })
}

// Every picture the fixture asks for has to have SETTLED — decoded and laid out, or fallen back to its
// path text — before a single gap is read, else the frame is still growing under the measurement.
async function settled(page: import("puppeteer").Page) {
  await page.evaluate(async () => {
    await Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null))))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
}

// Every gap between consecutive tool CARDS inside one message, in document order.
async function cardGaps(page: import("puppeteer").Page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-virtualized-transcript] .frizz-bash")]
      .filter((el) => !el.parentElement?.closest(".frizz-bash"))
    return cards.slice(1).map((c, i) => Math.round((c.getBoundingClientRect().top - cards[i].getBoundingClientRect().bottom) * 10) / 10)
  })
}

test("a picture takes its own gap on both sides, and the compact exceptions around it keep their rail", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    // 1. The reported shape: an image Read, then the live shimmer.
    await page.goto(fixtureUrl(""), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    await settled(page)
    const live = await tailGap(page)
    assert.equal(live.error, undefined, `thread transcript must mount a live tail: ${live.error}`)
    near(live.aboveWorking!, PICTURE, "the shimmer under a picture")

    // 1b. An image Read is no picture card: it folds into the digest, a bare label row, so the shimmer
    //     under it takes the label's ordinary step — and no picture is drawn until the human opens it.
    await page.goto(fixtureUrl("?case=folded"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    await settled(page)
    const folded = await tailGap(page)
    assert.equal(folded.error, undefined, `thread transcript must mount a live tail: ${folded.error}`)
    near(folded.aboveWorking!, STEP, "the shimmer under a folded image Read")
    assert.equal(await page.$("[data-tool-image]"), null, "the image Read's card sits inside the collapsed digest")
    assert.equal(await page.$$eval("[data-virtualized-transcript] img", (imgs) => imgs.length), 0, "no picture is drawn")

    // 2. CONTROL: two compact background-op rows in the same shapes. The seam between them stays on one
    //    rail and the shimmer below them at the tight run — the picture gap is charged to pictures, not
    //    to every row that escapes the digest.
    await page.goto(fixtureUrl("?case=control"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    await settled(page)
    const control = await cardGaps(page)
    // Two cards, one seam: the lead-in Bash is inside the collapsed digest and draws no card of its own.
    assert.equal(control.length, 1, `the control must draw two op cards, got ${control.length + 1}`)
    for (const gap of control) near(gap, RAIL, "a compact exception seam")
    near((await tailGap(page)).aboveWorking!, TIGHT, "the shimmer under a compact card")

    // 3. Two picture cards batched in ONE message, then an ordinary tool band in the next: the seam
    //    inside the band and the seam across the message boundary both take the picture's gap.
    await page.goto(fixtureUrl("?case=cards"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[data-frizz-msg="m4"]')
    await settled(page)
    // The two picture BLOCKS are read as the message column's own children, not as `figure.frizz-bash`.
    // That selector is what this test used to use, and it stopped matching without anything about the
    // SPACING changing: `/local-image` is not served here, so the picture falls back to a bare line of
    // path text INSTEAD of the ImageFrame — no `figure`. The header above has always said the bytes need
    // not arrive, and the gap is charged off the tool's own field; the probe was the only part that
    // quietly depended on the frame surviving. Reading the blocks positionally keeps this measuring the
    // rule rather than the chrome, and works whether or not the picture loads. (Measured 2026-08-24: the
    // gaps were right the whole time — this file had simply not run since the fallback changed, because
    // nothing set its env gate.)
    const stacked = await page.evaluate(() => {
      const scope = document.querySelector("[data-virtualized-transcript]")!
      const pictures = scope.querySelector('[data-frizz-msg="m3"] > div > div')!
      const blocks = [...pictures.children].filter((el) => el.getAttribute("aria-hidden") === null)
      const digest = scope.querySelector('[data-frizz-msg="m4"]')!
      const lastPicture = blocks[blocks.length - 1]
      if (blocks.length < 2) throw new Error(`expected two picture blocks in m3, got ${blocks.length}`)
      return {
        betweenPictures: Math.round((lastPicture.getBoundingClientRect().top - blocks[blocks.length - 2].getBoundingClientRect().bottom) * 10) / 10,
        intoDigest: Math.round((digest.getBoundingClientRect().top - lastPicture.getBoundingClientRect().bottom) * 10) / 10,
      }
    })
    near(stacked.betweenPictures, PICTURE, "the seam between two stacked pictures")
    near(stacked.intoDigest, PICTURE, "the seam out of a picture into a digest")

    // 4. Prose below a picture: already the widest ordinary boundary, and it widens to the picture's.
    await page.goto(fixtureUrl("?case=prose"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[data-frizz-msg="m4"]')
    await settled(page)
    const prose = await page.evaluate(() => {
      const scope = document.querySelector("[data-virtualized-transcript]")!
      const rows = [...scope.querySelectorAll("[data-frizz-msg]")]
      const i = rows.findIndex((r) => r.getAttribute("data-frizz-msg") === "m4")
      return Math.round((rows[i].getBoundingClientRect().top - rows[i - 1].getBoundingClientRect().bottom) * 10) / 10
    })
    near(prose, PICTURE, "prose under a picture")

    // 5. A picture a worker writes INTO its prose is not a card — it belongs to the sentence that
    //    introduces it, so both spellings keep the PROSE step. The claim is that they AGREE: the
    //    Markdown one is spaced in CSS and the bare path in the block list, so moving one alone puts
    //    two different gaps under two identical frames in the same message.
    await page.goto(fixtureUrl("?case=prose-picture"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector(".md-image-frame")
    await settled(page)
    const embedded = await page.evaluate(() => {
      const r = (e: Element) => e.getBoundingClientRect()
      const paragraphs = [...document.querySelectorAll(".md-body p")]
      const below = (frame: Element | null) => {
        if (!frame) return null
        const next = paragraphs.filter((p) => r(p).top >= r(frame).bottom - 1).sort((a, b) => r(a).top - r(b).top)[0]
        return next ? Math.round((r(next).top - r(frame).bottom) * 10) / 10 : null
      }
      // The bare-path block, found positionally for the same reason as the stacked probe above: with
      // `/local-image` unserved, `BlockImage` renders its `broken` fallback and there is no
      // `.frizz-bash` frame to select. It is the message column's one child that is neither a prose
      // body nor a spacer — which is exactly what "its own block in the transcript's rhythm" means, and
      // is what this assertion is about. The Markdown frame is unaffected: that one is sanitized HTML
      // carrying the frame classes, so it survives its `<img>` failing to load.
      const column = document.querySelector('[data-frizz-msg="m3"]')!
      const barePathBlock = [...column.children].find(
        (el) => el.getAttribute("aria-hidden") === null && !el.classList.contains("md-body"),
      ) ?? null
      return {
        markdown: below(document.querySelector(".md-image-frame")),
        barePath: below(barePathBlock),
      }
    })
    near(embedded.markdown!, STEP, "prose under a Markdown picture")
    near(embedded.barePath!, STEP, "prose under a bare-path picture")

    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})
