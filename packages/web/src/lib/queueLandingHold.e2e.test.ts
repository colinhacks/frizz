import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "puppeteer"

// What the page's fixture (queue-landing-hold-fixture.tsx) puts on `window`.
declare global {
  interface Window {
    __route: (slug: string) => void
    __grow: (slug: string, px: number) => void
    __spy: () => string | null
  }
}

// Runtime coverage for the queue's LANDING HOLD (lib/queueLandingHold.ts), which only a browser can
// settle: it is a race between a one-shot scroll and the layout that arrives after it. A desktop deep
// link to a queue card BELOW another card landed while the whole queue was still skeletons, the browser
// clamped the scroll to 0, and the card above then grew and pushed the routed card ~1,400px out of
// view, taking the sidebar's reading marker with it (2026-10-05). Skipped unless a Vite URL serving the
// fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and
// set FRIZZ_QUEUE_LANDING_HOLD_E2E_URL to its origin, or run `nub run test:e2e -- queueLandingHold`.
const baseUrl = process.env.FRIZZ_QUEUE_LANDING_HOLD_E2E_URL

// QUEUE_CARD_VIEWPORT_TOP in store.ts — where a landed card's border sits below the viewport top.
const LANDING = 40

async function open(anchor: "auto" | "none") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/queue-landing-hold-fixture.html${anchor === "none" ? "?anchor=none" : ""}`, { waitUntil: "networkidle0" })
  await page.waitForSelector('[data-queue-card-root="hold-b"]')
  return { browser, page, errors }
}

const settle = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))))

const probe = (page: Page) => page.evaluate(() => ({
  bTop: Math.round(document.querySelector('[data-queue-card-root="hold-b"]')!.getBoundingClientRect().top),
  scrollY: Math.round(window.scrollY),
  docHeight: document.documentElement.scrollHeight,
  spy: window.__spy(),
  drawerOpen: document.querySelector("[data-fixture-thread-drawer]") !== null,
}))

// The cold deep link: route while the page cannot scroll yet, then let the transcripts arrive.
async function deepLinkThenLoad(page: Page) {
  const before = await probe(page)
  assert.ok(before.docHeight <= 900, `the skeleton queue must fit the viewport, as it did on the real cold load (doc ${before.docHeight}px)`)
  await page.evaluate(() => window.__route("hold-b"))
  await settle(page)
  const routed = await probe(page)
  assert.equal(routed.scrollY, 0, "the landing is clamped: there is nothing to scroll yet")
  assert.equal(routed.drawerOpen, false, "a queued thread's deep link scrolls to its card, never stacks a drawer")
  // Transcripts arrive: both cards grow, the one above by far more than a viewport.
  await page.evaluate(() => { window.__grow("hold-a", 1500); window.__grow("hold-b", 1700) })
  await settle(page)
}

test("a deep-linked queue card stays landed and selected while the card above it grows", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await open("auto")
  try {
    await deepLinkThenLoad(page)
    const loaded = await probe(page)
    // THE REGRESSION: bTop read 1,889 here (and the marker read hold-a) before the hold existed.
    assert.equal(loaded.bTop, LANDING, `the routed card lands once the page can scroll (bTop ${loaded.bTop})`)
    assert.equal(loaded.spy, "hold-b", "the sidebar's reading marker follows the routed card, not the one above")

    // Pictures in the card above load next — the second wave of growth.
    await page.evaluate(() => window.__grow("hold-a", 1400))
    await settle(page)
    const pictures = await probe(page)
    assert.equal(pictures.bTop, LANDING, "still landed after the card above grows again")
    assert.equal(pictures.spy, "hold-b")
    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})

test("the hold, not the browser's scroll anchoring, is what keeps the card landed", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  // The negative control for the reader test below: with native anchoring OFF, a card above growing
  // with no reader input must still leave the routed card landed. If this failed, the reader test
  // could pass merely because nothing was holding the card at all.
  const { browser, page, errors } = await open("none")
  try {
    await deepLinkThenLoad(page)
    assert.equal((await probe(page)).bTop, LANDING)
    await page.evaluate(() => window.__grow("hold-a", 500))
    await settle(page)
    assert.equal((await probe(page)).bTop, LANDING, "re-landed by the hold, with anchoring off")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

for (const how of ["wheel", "scrollbar"] as const) {
  test(`a reader who scrolls away (${how}) is not pulled back to the card`, {
    skip: !baseUrl,
    timeout: 60_000,
  }, async () => {
    const { browser, page, errors } = await open("none")
    try {
      await deepLinkThenLoad(page)
      const landed = await probe(page)
      assert.equal(landed.bTop, LANDING)
      if (how === "wheel") {
        await page.mouse.move(700, 500)
        await page.mouse.wheel({ deltaY: -600 })
      } else {
        // Dragging the page's own scrollbar delivers no wheel/pointer/key event to the page — only the
        // scroll. A scripted scroll is the same shape, so the hold must read it from geometry alone.
        await page.evaluate(() => window.scrollBy(0, -600))
      }
      await page.waitForFunction((y) => Math.round(window.scrollY) <= y - 590, {}, landed.scrollY)
      await settle(page)
      const scrolled = await probe(page)
      assert.equal(scrolled.bTop, LANDING + 600, "the reader's scroll is not undone")
      // The layout moves after the reader took over: the hold must stay released.
      await page.evaluate(() => window.__grow("hold-a", 500))
      await settle(page)
      const after = await probe(page)
      assert.equal(after.scrollY, scrolled.scrollY, "the page stays where the reader put it")
      assert.equal(after.bTop, scrolled.bTop + 500, "and the card is NOT re-landed")
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}
