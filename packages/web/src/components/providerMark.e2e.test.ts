import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_PROVIDER_MARK_E2E_URL

test("sidebar provider marks center on the last title line's cap band", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.goto(`${baseUrl}/provider-mark-fixture.html`)
    const selector = '[data-sidebar-item] .whitespace-nowrap > [role="img"]'
    await page.waitForSelector(selector)
    for (const width of [820, 330]) {
      await page.setViewport({ width, height: 800 })
      const marks = await page.$$eval(selector, (elements) => elements.map((element) => {
        // This empty inline block has its bottom edge on the last word's baseline, and its top
        // exactly one cap height above it. Zero width keeps the title's line breaks unchanged.
        const probe = document.createElement("span")
        probe.style.cssText = "display:inline-block;width:0;height:1cap;vertical-align:baseline"
        element.before(probe)
        const band = probe.getBoundingClientRect()
        const shapes = Array.from(element.querySelectorAll("svg :is(path,rect,circle,ellipse,polyline,polygon,line)"))
        const ink = shapes.map((shape) => shape.getBoundingClientRect())
        probe.remove()
        const center = (Math.min(...ink.map((rect) => rect.top)) + Math.max(...ink.map((rect) => rect.bottom))) / 2
        return { label: element.getAttribute("aria-label"), offset: center - (band.top + band.bottom) / 2 }
      }))
      assert.equal(marks.length, 9)
      for (const { label, offset } of marks) {
        assert.ok(Math.abs(offset) < 0.25, `${label} is ${offset.toFixed(2)}px off at ${width}px`)
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
