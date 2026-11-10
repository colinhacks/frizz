import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_QUOTE_COPY_E2E_URL to its origin, e.g.
//   FRIZZ_QUOTE_COPY_E2E_URL=http://localhost:5947 nub run test packages/web/src/lib/quoteCopy.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUOTE_COPY_E2E_URL

type FixtureWindow = Window & { __chipHits?: number; __reply?: string }

// lib/quoteCopy.test.ts pins which quotes are marked and what each files. The rest of the feature is the
// seam: the sanitizer turning a mark into a button (and refusing a forged one), the stylesheet floating
// it into the first line, and the delegated listener putting the right text on the REAL clipboard. Read
// back through CDP's clipboard permission, as lib/copyCodeBlock.e2e.test.ts explains.
test("a blockquote copies its own Markdown, shows nothing it does not copy, and makes room on its first line only", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    const cdp = await browser.target().createCDPSession()
    await cdp.send("Browser.grantPermissions", {
      origin: baseUrl!,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    // The fixture declares no favicon, so vite 404s /favicon.ico on every bare fixture page here.
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon\.ico|404 \(Not Found\)/.test(m.text())) pageErrors.push(m.text())
    })
    await page.setViewport({ width: 900, height: 2400, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/quote-copy-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-case=narrow] .md-quote-copy")

    // NOTE: no named function expressions in evaluate. Nub's transpiler adds a `__name` keep-names shim
    // that does not exist inside the page.

    // ── Which quotes got a button, and what each carries ──
    const shape = await page.evaluate(() => {
      const read = (id: string) => [...document.querySelectorAll(`[data-case=${id}] blockquote`)].map((quote) => {
        const button = quote.querySelector(":scope > .md-quote-copy")
        return {
          className: quote.className,
          first: button !== null && quote.firstElementChild === button,
          source: button?.getAttribute("data-md-source") ?? null,
        }
      })
      // Every source attribute on the page, wherever it is.
      const carriers = [...document.querySelectorAll("[data-md-source]")].map((el) =>
        el.matches(".md-quote > .md-quote-copy:first-child"))
      const ids = ["reply", "short", "nested", "hidden", "kbd", "listed", "callout", "empty", "forged", "chip"]
      return { cases: Object.fromEntries(ids.map((id) => [id, read(id)])), carriers }
    })
    const { cases } = shape
    assert.deepEqual(cases.reply, [{ className: "md-quote", first: true, source: await page.evaluate(() => (window as FixtureWindow).__reply!) }])
    assert.deepEqual(cases.short, [{ className: "md-quote", first: true, source: "One short line." }])
    assert.deepEqual(cases.nested.map((q) => q.className), ["md-quote", ""], "only the outer quote is marked")
    assert.equal(cases.nested[0].source, "The reporter wrote:\n\n> It hangs on `frizz --app`.\n\nand that is the bug.")
    assert.equal(cases.nested[1].first, false)
    assert.deepEqual(cases.hidden, [{ className: "md-quote", first: true, source: null }], "a quote hiding text carries no source")
    assert.equal(cases.kbd[0].source, "Press <kbd>⌘</kbd> <kbd>K</kbd> to open it.")
    assert.equal(cases.listed[0].source, "Closing as fixed in `0.15.27`.")
    assert.deepEqual(cases.callout.map((q) => [q.className, q.first]), [["md-callout md-callout-warning", false]])
    assert.deepEqual(cases.empty, [{ className: "", first: false, source: null }])
    // An author writes no class (lib/markdown.ts CLASS_BY_TAG), so a guessed mark, a hand-written
    // `md-quote` and a hand-written copy button all arrive bare: no button the copy handler knows, and
    // never the attribute only the sanitizer may write.
    assert.deepEqual(cases.forged.map((q) => [q.className, q.first, q.source]), [
      ["", false, null],
      ["", false, null],
    ])
    assert.equal(cases.chip[0].source, "Thanks — fixed in `4dc44d0`, out in the next release.")
    assert.ok(shape.carriers.length > 5 && shape.carriers.every(Boolean), "a source only ever rides on a minted button")

    // ── Geometry: the float takes the first line's end, and only that line's ──
    const geometry = await page.evaluate(() => {
      // Plain numbers: a DOMRect's fields are prototype getters and serialize out of the page as `{}`.
      const box = (el: Element) => { const { left, right, top, bottom } = el.getBoundingClientRect(); return { left, right, top, bottom } }
      const lines = (el: Element) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        // One right edge per line, top to bottom.
        const byTop = new Map<number, number>()
        for (const r of range.getClientRects()) byTop.set(Math.round(r.top), Math.max(byTop.get(Math.round(r.top)) ?? 0, r.right))
        return [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(([, right]) => right)
      }
      const read = (id: string) => {
        const quote = document.querySelector(`[data-case=${id}] .md-quote`)!
        const button = quote.querySelector(".md-quote-copy")!
        const paragraph = quote.querySelector(":scope > p")!
        return { quote: box(quote), button: box(button), lineHeight: parseFloat(getComputedStyle(paragraph).lineHeight), firstTop: box(paragraph).top, lines: lines(paragraph) }
      }
      const codeFirst = document.querySelector("[data-case=code-first] .md-quote")!
      return {
        long: read("long"),
        narrow: (() => { const quotes = document.querySelectorAll("[data-case=narrow] .md-quote"); const q = quotes[1]; const p = q.querySelector(":scope > p")!; return { button: box(q.querySelector(".md-quote-copy")!), lines: lines(p) } })(),
        card: read("card"),
        chip: read("chip"),
        replyButtonRight: box(document.querySelector("[data-case=reply] .md-quote-copy")!).right,
        codeButtonRight: box(document.querySelector("[data-case=reply] .md-code-copy")!).right,
        codeFirst: { quote: box(codeFirst.querySelector(".md-quote-copy")!), code: box(codeFirst.querySelector(".md-code-copy")!) },
      }
    })
    for (const [name, quote] of [["long", geometry.long], ["narrow", geometry.narrow]] as const) {
      const [first, ...rest] = quote.lines
      assert.ok(rest.length >= 2, `${name}: the paragraph wraps`)
      assert.ok(first < quote.button.left, `${name}: the first line ends before the button (${first} vs ${quote.button.left})`)
      assert.ok(Math.max(...rest) > quote.button.left, `${name}: a later line runs past where the button stands`)
    }
    for (const [name, quote] of [["long", geometry.long], ["card", geometry.card], ["chip", geometry.chip]] as const) {
      // Centred on the first line, at every scale.
      const centre = (quote.button.top + quote.button.bottom) / 2
      assert.ok(Math.abs(centre - (quote.firstTop + quote.lineHeight / 2)) < 0.6, `${name}: the button is centred on the first line`)
    }
    assert.ok(Math.abs(geometry.replyButtonRight - geometry.codeButtonRight) < 0.5, "a quote's button stands in a code block's button column")
    assert.ok(geometry.codeFirst.code.right <= geometry.codeFirst.quote.left, "a quote opening with code keeps the two buttons apart")

    // ── Quiet until the quote is hovered ──
    const opacity = (id: string) => page.$eval(`[data-case=${id}] .md-quote-copy`, (b) => getComputedStyle(b).opacity)
    assert.equal(await opacity("reply"), "0")
    await page.hover("[data-case=reply] .md-quote > p")
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-case=reply] .md-quote-copy")!).opacity === "1")

    // ── The copy itself ──
    const copyFrom = async (id: string) => {
      await page.hover(`[data-case=${id}] .md-quote`)
      await page.click(`[data-case=${id}] .md-quote-copy`)
      await page.waitForFunction((i: string) => document.querySelector(`[data-case=${i}] .md-quote-copy`)!.classList.contains("is-copied"), {}, id)
      return page.evaluate(() => navigator.clipboard.readText())
    }
    assert.equal(await copyFrom("reply"), await page.evaluate(() => (window as FixtureWindow).__reply!))
    assert.equal(await page.$eval("[data-case=reply] .md-quote-copy", (b) => (b as HTMLButtonElement).title), "Copied")
    await page.waitForFunction(() => !document.querySelector("[data-case=reply] .md-quote-copy")!.classList.contains("is-copied"), { timeout: 5_000 })
    assert.equal(await page.$eval("[data-case=reply] .md-quote-copy", (b) => (b as HTMLButtonElement).title), "Copy quote")

    // A quote that hides something copies what it shows.
    assert.equal(await copyFrom("hidden"), "Visible words.")
    // The nested reply carries its inner quote's markers.
    assert.match(await copyFrom("nested"), /^The reporter wrote:\n\n> It hangs on `frizz --app`\.\n\nand that is the bug\.$/)
    // The author's own button is no copy button at all: nothing in the forged case answers to the copy
    // handler, and a click on it never puts its attribute's payload on the clipboard.
    assert.equal(await page.$$eval("[data-case=forged] .md-quote-copy, [data-case=forged] [data-md-source]", (found) => found.length), 0)
    await page.click("[data-case=forged] button")
    assert.doesNotMatch(await page.evaluate(() => navigator.clipboard.readText()), /rm -rf/)

    // ── In an answer chip: revealed by the quote, and a click on it copies without picking ──
    await page.hover("[data-case=chip] .md-quote > p")
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-case=chip] .md-quote-copy")!).opacity === "1")
    const hit = await page.$eval("[data-case=chip] .md-quote-copy", (button) => {
      const r = button.getBoundingClientRect()
      return document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2) === button
    })
    assert.equal(hit, true, "the button is on top of the chip's stretched button")
    assert.equal(await copyFrom("chip"), "Thanks — fixed in `4dc44d0`, out in the next release.")
    assert.equal(await page.evaluate(() => (window as FixtureWindow).__chipHits), 0)

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
