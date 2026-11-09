import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "puppeteer"

// Range selection is a MOUSE gesture: the modifier, the anchor, the browser's own text-selection
// reflex. Unit tests pin the reducer, but only a real browser proves the wiring — that shift reaches
// the handler, that the row's title link doesn't swallow the click, and that dragging across rows
// doesn't paint a text selection over the list. The list also loads as it SCROLLS, which only a real
// scroll container and a real IntersectionObserver can prove. Drive the real component in the fixture
// page (github-picker-range-fixture.tsx, whose header lists the query knobs used below).
const baseUrl = process.env.FRIZZ_GITHUB_PICKER_RANGE_E2E_URL

type Fixture = { dispatched: unknown[]; listRequests: number[] }
const MORE = "[data-github-list-more]"

async function open(query = "") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.setViewport({ width: 1100, height: 950, deviceScaleFactor: 1 })
  await page.goto(`${baseUrl}/github-picker-range-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector('[data-row-number="412"]')
  return { browser, page, errors, notFound }
}

const rowNumbers = (page: Page) => page.$$eval("[data-row-number]", (rows) => rows.map((r) => Number(r.getAttribute("data-row-number"))))
const checked = (page: Page) => page.$$eval("[data-row-number]", (rows) =>
  rows.filter((r) => r.getAttribute("aria-pressed") === "true").map((r) => Number(r.getAttribute("data-row-number"))))
const bodyText = (page: Page) => page.$eval("body", (node) => node.innerText.replace(/\s+/g, " "))
const listRequests = (page: Page) => page.evaluate(() => [...(window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.listRequests])
// The scroll container is the rows' parent.
const scrollListToEnd = (page: Page) => page.evaluate(() => {
  const list = document.querySelector("[data-row-number]")!.parentElement!
  list.scrollTop = list.scrollHeight
})
const waitForRows = (page: Page, count: number) =>
  page.waitForFunction((n: number) => document.querySelectorAll("[data-row-number]").length === n, { timeout: 5000 }, count)

test("shift-clicking two rows in the GitHub picker selects every row in between, across fetched pages and uncapped", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { browser, page, errors, notFound } = await open()

  // The checkbox sits at the row's left edge — click there so the gesture never lands on the title
  // link (which stops propagation and would open GitHub instead of selecting).
  const CHECKBOX = { x: 14, y: 14 }
  const row = (n: number) => `[data-row-number="${n}"]`
  const click = async (n: number, shift = false) => {
    if (shift) await page.keyboard.down("Shift")
    await page.click(row(n), { offset: CHECKBOX })
    if (shift) await page.keyboard.up("Shift")
  }

  try {
    const numbers = await rowNumbers(page)
    assert.equal(numbers.length, 30, "the first fetch renders a full page of rows")
    assert.deepEqual(await listRequests(page), [1], "nothing past the first page is fetched before the list is scrolled")
    assert.match(await bodyText(page), /74 open issues/, "the totals line states the full result count, not the loaded rows'")
    assert.doesNotMatch(await bodyText(page), /Page \d+ of/, "there is no pager")
    assert.equal(await page.$('[aria-label="Next page"]'), null)
    assert.ok(await page.$(MORE), "the list's end says there is more to load")
    assert.deepEqual(await checked(page), [], "nothing is selected before the first click")

    // The gesture from the task: click one row, shift-click another, get everything in between.
    await click(400)
    await click(366, true)
    assert.deepEqual(await checked(page), [400, 398, 395, 390, 388, 381, 377, 370, 366])

    // Shift+click must not leave the browser's own text selection smeared across the rows.
    assert.equal(await page.evaluate(() => String(window.getSelection() ?? "")), "")

    // A second shift-click re-spans from the SAME anchor, so the range widens rather than restarting.
    await click(348, true)
    assert.deepEqual(await checked(page), [400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348])

    // Shift-clicking UPWARD from a fresh anchor is symmetric, and rows outside the span are untouched.
    await click(321)
    await click(330, true)
    assert.deepEqual(await checked(page), [400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348, 330, 328, 321])

    // Plain-click an already-checked row to uncheck it, then shift-click: the range CLEARS.
    await click(390)
    await click(377, true)
    assert.deepEqual(await checked(page), [400, 398, 395, 370, 366, 361, 359, 352, 348, 330, 328, 321])

    // Selecting the whole first page in one shift-click is not capped at 20. Reload for a clean, empty
    // selection.
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector('[data-row-number="412"]')
    await click(412)
    await click(numbers[numbers.length - 1]!, true)
    assert.deepEqual(await checked(page), numbers, "a range across the whole first page selects all 30 rows, uncapped")
    assert.match(await bodyText(page), /30 selected/, "the footer counts the running selection")

    // Scrolling to the end loads the next page beneath, and the selection stands. "At least": the
    // shift-click on the page's last row scrolled it into view, which may already have asked for page
    // two, and then this scroll asks for page three.
    await scrollListToEnd(page)
    await page.waitForFunction(() => document.querySelectorAll("[data-row-number]").length >= 60, { timeout: 5000 })
    const loaded = await rowNumbers(page)
    assert.deepEqual(loaded.slice(0, 30), numbers, "the second page is appended, not swapped in")
    assert.equal(new Set(loaded).size, loaded.length, "and is a different window of the list")
    assert.deepEqual(await checked(page), numbers, "the first page's checks are untouched")

    // A shift-click range runs straight across the seam between the two fetched pages.
    await click(loaded[33]!, true)
    assert.deepEqual(await checked(page), loaded.slice(0, 34), "the range extends four rows into the second page")
    assert.match(await bodyText(page), /34 selected/)
    assert.match(await bodyText(page), /Start 34 investigations/, "the button names the whole batch")

    // The last page is short, and once it lands there is nothing more to load or ask for.
    await scrollListToEnd(page)
    await waitForRows(page, 74)
    await page.waitForFunction((more: string) => !document.querySelector(more), { timeout: 3000 }, MORE)
    await scrollListToEnd(page)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await listRequests(page), [1, 2, 3], "one request per page, and none past the last")
    assert.equal(await page.$eval("[data-row-number]:last-child", (r) => getComputedStyle(r).borderBottomWidth), "0px", "the last row draws no rule against the list's own border")

    // What dispatches is the whole batch — 34 items, well past the old cap of 20.
    await page.$$eval("button", (buttons) => {
      const start = buttons.find((b) => b.textContent?.trim() === "Start 34 investigations")
      if (!start) throw new Error("the dispatch button is missing")
      if ((start as HTMLButtonElement).disabled) throw new Error("the dispatch button is disabled")
      ;(start as HTMLButtonElement).click()
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const sent = await page.evaluate(() => window.githubPickerRangeFixture?.dispatched ?? [])
    assert.equal(sent.length, 1, "one batch went out")
    const batch = (sent[0] as { items: { number: number }[] }).items
    assert.equal(batch.length, 34, "every checked row dispatches, across pages and past the old 20 cap")
    assert.deepEqual(batch.map((item) => item.number).sort((a, b) => b - a), loaded.slice(0, 34).sort((a, b) => b - a))

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})

test("a repo that fits in one fetch gets the totals line and nothing to load", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { browser, page, errors } = await open("?rows=8")
  try {
    assert.match(await bodyText(page), /8 open issues/, "the totals line is worth showing even for one page")
    assert.equal(await page.$(MORE), null, "no loader row when there is nothing more")
    await scrollListToEnd(page)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await listRequests(page), [1])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the next page shows a spinner while it loads, and a failed page offers Retry", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { browser, page, errors } = await open("?listDelay=700&failPage=3")
  try {
    await scrollListToEnd(page)
    await page.waitForSelector(`${MORE} [aria-label="Loading more"]`, { timeout: 2000 })
    assert.equal((await rowNumbers(page)).length, 30, "the spinner shows while page two is still on its way")
    await waitForRows(page, 60)

    // Page three's first request fails: the end of the list says so, and nothing re-asks on its own.
    await scrollListToEnd(page)
    await page.waitForFunction((more: string) => /Couldn't load more/.test(document.querySelector(more)?.textContent ?? ""), { timeout: 5000 }, MORE)
    await scrollListToEnd(page)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await listRequests(page), [1, 2, 3], "a failed page is not retried behind the human's back")

    await page.evaluate((more: string) => {
      [...document.querySelectorAll<HTMLButtonElement>(`${more} button`)].find((b) => b.textContent?.trim() === "Retry")!.click()
    }, MORE)
    await waitForRows(page, 74)
    assert.deepEqual(await listRequests(page), [1, 2, 3, 3])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a row that moves between fetches is drawn once, and a list past GitHub's search window says where it stops", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // Each later page starts with the previous page's last row, as when an issue is opened mid-scroll.
  const { browser, page, errors } = await open("?drift=1&searchTotal=1500")
  try {
    await scrollListToEnd(page)
    await waitForRows(page, 59)
    await scrollListToEnd(page)
    await page.waitForFunction((more: string) => !document.querySelector(more), { timeout: 5000 }, MORE)
    const loaded = await rowNumbers(page)
    assert.equal(loaded.length, new Set(loaded).size, "no number is drawn twice")
    assert.equal(loaded.length, 74, "every row arrives, each once")
    assert.match(await bodyText(page), /1,500 open issues/)
    assert.match(await bodyText(page), /GitHub's search lists the first 1,000 of these/)
    // React reports a duplicate key as a console error, which `errors` would hold.
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a list nothing shows is dropped, so coming back to it fetches one page, not every page it had scrolled through", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // A cached infinite list refetches every page it holds on its next mount — one GitHub search call
  // each, against a limit of about 30 a minute.
  const { browser, page, errors } = await open()
  const tab = (label: string) => page.evaluate((l: string) => {
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === l)!.click()
  }, label)
  try {
    await scrollListToEnd(page)
    await waitForRows(page, 60)
    await scrollListToEnd(page)
    await waitForRows(page, 74)
    assert.deepEqual(await listRequests(page), [1, 2, 3])
    await tab("PRs")
    await page.waitForFunction(() => document.querySelectorAll("[data-row-number]").length === 30, { timeout: 5000 })
    await tab("Issues")
    await page.waitForFunction(() => document.querySelectorAll("[data-row-number]").length === 30, { timeout: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await listRequests(page), [1, 2, 3, 1, 1], "the issues list came back as its first page alone")
    assert.equal(await page.evaluate(() => document.querySelector("[data-row-number]")!.parentElement!.scrollTop), 0, "and at the top")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
