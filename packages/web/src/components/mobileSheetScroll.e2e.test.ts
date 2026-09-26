import assert from "node:assert/strict"
import test from "node:test"

// FRIZZ_MOBILE_SHEET_SCROLL_E2E_URL=<vite origin> — `nub run test:e2e` sets it.
const baseUrl = process.env.FRIZZ_MOBILE_SHEET_SCROLL_E2E_URL

// A `.md` reader opened from a thread on a phone rendered and would not scroll: the thread sheet is a
// modal Radix dialog below 800px, its react-remove-scroll lock cancelled every touchmove and wheel
// outside the dialog, and the reader is a sibling layer, not inside it. The fixture mounts both layers
// in ONE commit, which is also the order in which the thread's lock lands on top (Radix mounts it a
// commit late) — so this fails if the lock handover depends on mount order, not only if it is missing.
test("a .md reader stacked over a thread scrolls by touch and by wheel on a phone", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.goto(`${baseUrl}/mobile-sheet-scroll-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(".frizz-sheet-panel .md-body")
    await page.waitForSelector("[role=dialog][aria-modal=true]")
    const scroller = await page.$eval(".frizz-sheet-panel .md-body", (body) => {
      const el = body.closest<HTMLElement>(".overflow-y-auto")!
      el.setAttribute("data-test-reader-scroller", "")
      const box = el.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, overflow: el.scrollHeight - el.clientHeight }
    })
    assert.ok(scroller.overflow > 1000, `the fixture document must overflow the reader (overflow ${scroller.overflow}px)`)
    const scrollTop = () => page.$eval("[data-test-reader-scroller]", (el) => el.scrollTop)
    const settle = async (above: number) => {
      for (let i = 0; i < 40; i++) {
        const top = await scrollTop()
        if (top > above) return top
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return scrollTop()
    }

    // A real finger drag: trusted touch events (Input.dispatchTouchEvent), so a cancelled touchmove
    // stops it exactly as it stops a phone. Not Input.synthesizeScrollGesture — on Chrome 153 that
    // emitted no touchmove at all and never scrolled, fix or no fix.
    await page.touchscreen.touchStart(scroller.x, scroller.y + 150)
    for (let step = 1; step <= 10; step++) await page.touchscreen.touchMove(scroller.x, scroller.y + 150 - step * 30)
    await page.touchscreen.touchEnd()
    const afterTouch = await settle(0)
    assert.ok(afterTouch > 0, "a touch drag over the reader must scroll it")

    await page.mouse.move(scroller.x, scroller.y)
    await page.mouse.wheel({ deltaY: 400 })
    assert.ok((await settle(afterTouch)) > afterTouch, "a wheel over the reader must scroll it")

    // The page behind stays locked while the reader is up — the reader took the lock, nobody dropped it.
    assert.notEqual(await page.evaluate(() => document.body.getAttribute("data-scroll-locked")), null)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
