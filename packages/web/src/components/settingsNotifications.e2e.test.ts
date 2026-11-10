import assert from "node:assert/strict"
import test from "node:test"

// "Allow notifications", in a real Settings drawer and on the phone's Settings page. The permission
// itself cannot be asked of a headless browser, so settings-formatting-fixture stands in for
// `window.Notification` (`?notifications=default`): not yet asked, granting on the first ask, counting
// the asks. What is real is the drawer, the button and what the line says afterwards.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_SETTINGS_NOTIFICATIONS_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_SETTINGS_NOTIFICATIONS_E2E_URL

const BUTTON = "[data-allow-notifications]"
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const DESKTOP = { width: 900, height: 1000, deviceScaleFactor: 1 }

async function launch(query: string, viewport: typeof PHONE | typeof DESKTOP) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport(viewport)
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  try {
    await page.goto(`${baseUrl}/settings-formatting-fixture.html${query}`, { waitUntil: "networkidle0" })
  } catch (error) {
    // A page that never loaded has no `finally` to close its browser: the caller never got one.
    await browser.close()
    throw error
  }
  return { browser, page, errors }
}
const asks = (page: import("puppeteer").Page) => page.evaluate(() => (window as unknown as { __notificationAsks: () => number }).__notificationAsks())
const says = (page: import("puppeteer").Page, text: string) =>
  page.waitForFunction((text) => document.body.textContent?.includes(text), { timeout: 10_000 }, text)

for (const [name, viewport] of [["the drawer", DESKTOP], ["the phone's page", PHONE]] as const) {
  test(`${name}: a browser not yet asked is asked by the button, once, and the line then says it is granted`, { skip: !baseUrl, timeout: 60_000 }, async () => {
    const { browser, page, errors } = await launch("?notifications=default", viewport)
    try {
      await page.waitForSelector(BUTTON)
      assert.equal(await asks(page), 0, "opening Settings asks nothing")
      await says(page, "Not yet allowed in this browser")
      await page.click(BUTTON)
      await page.waitForSelector(BUTTON, { hidden: true })
      await says(page, "Browser permission granted")
      assert.equal(await asks(page), 1)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}

test("a prompt the user closed without answering leaves the button for another try", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?notifications=default&answer=dismissed", DESKTOP)
  try {
    await page.waitForSelector(BUTTON)
    await page.click(BUTTON)
    await page.waitForFunction(() => (window as unknown as { __notificationAsks: () => number }).__notificationAsks() === 1)
    assert.notEqual(await page.$(BUTTON), null)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a browser that refused is shown how to undo that, and no button that could not work", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("", DESKTOP)
  try {
    await says(page, "Notifications are blocked for this site")
    assert.equal(await page.$(BUTTON), null)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on the phone the button takes a press 44px tall", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?notifications=default", PHONE)
  try {
    await page.waitForSelector(BUTTON)
    const reach = await page.$eval(BUTTON, (el) => {
      el.scrollIntoView({ block: "center" })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const hits = (y: number) => document.elementFromPoint(x, y) === el
      return { height: r.height, above: hits(r.top - 6), below: hits(r.bottom + 6), beyond: hits(r.top - 12) }
    })
    assert.ok(reach.height < 44, "the button itself is drawn smaller than a fingertip")
    assert.deepEqual({ above: reach.above, below: reach.below, beyond: reach.beyond }, { above: true, below: true, beyond: false })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
