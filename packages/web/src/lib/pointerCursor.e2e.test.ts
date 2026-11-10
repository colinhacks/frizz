import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_POINTER_CURSOR_E2E_URL to its origin, e.g.
//   FRIZZ_POINTER_CURSOR_E2E_URL=http://localhost:5831 nub run test packages/web/src/lib/pointerCursor.e2e.test.ts
// (`nub run test:e2e-web` starts the vite and sets it for you.)
const baseUrl = process.env.FRIZZ_POINTER_CURSOR_E2E_URL

// styles.css gives the pointer to whatever a click acts on — by tag and by ARIA role — and keeps the
// arrow on anything disabled, `aria-disabled` included. The fixture marks each case with the cursor it
// must show; this reads the cursor of the element actually UNDER the pointer at the case's centre, so a
// child or an overlay that changes it fails here as surely as the element's own style would.
test("everything a click acts on shows the pointer, and a disabled control does not", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/pointer-cursor-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector('[role="menu"] [data-expect]')
    await page.waitForSelector('[data-expect-within] summary')

    // NOTE: no named function expressions in evaluate. Nub's transpiler adds a `__name` keep-names shim
    // that does not exist inside the page.
    const readings = await page.evaluate(() => {
      const cases = [
        ...[...document.querySelectorAll<HTMLElement>("[data-expect]")].map((el) => ({ el, expect: el.dataset.expect! })),
        ...[...document.querySelectorAll<HTMLElement>("[data-expect-within]")].map((host) => ({ el: host.querySelector<HTMLElement>(host.dataset.expectWithin!)!, expect: "pointer" })),
      ]
      return cases.map(({ el, expect }) => {
        const r = el.getBoundingClientRect()
        const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return {
          name: `${el.closest("[data-case]")?.getAttribute("data-case")}: ${el.textContent?.trim() || el.getAttribute("aria-label") || el.tagName}`,
          expect,
          own: getComputedStyle(el).cursor,
          // What the pointer shows is the cursor of the element under it, which must be this case's
          // own element or something inside it.
          under: under && (under === el || el.contains(under)) ? getComputedStyle(under).cursor : `covered by <${under?.tagName.toLowerCase()}>`,
        }
      })
    })
    assert.ok(readings.length >= 20, `the fixture rendered every case (${readings.length})`)
    const wrong = readings.filter((r) => r.own !== r.expect || r.under !== r.expect)
    assert.deepEqual(wrong, [], "every case shows the cursor it is marked with")
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
