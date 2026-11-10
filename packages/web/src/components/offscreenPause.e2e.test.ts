import assert from "node:assert/strict"
import test from "node:test"

// An infinite animation nobody can see still costs the machine a frame every vsync, and Chrome culls none of
// it: the Console's 16 live dots, all below the fold, held an idle page at 7-8% of a core against 0.8% with
// them paused (lib/offscreenPause.ts, 2026-11-09). Which animations a real browser is running is the browser's
// to say, so this asks it: a live dot or a box spinner out of view — below the page's fold or below a
// scrolling panel's — is paused, one in view runs, and one scrolled into view runs again.
//
//   cd packages/web && nubx vite --port 5951 --strictPort
//   FRIZZ_OFFSCREEN_PAUSE_E2E_URL=http://127.0.0.1:5951 nub run test packages/web/src/components/offscreenPause.e2e.test.ts
const baseUrl = process.env.FRIZZ_OFFSCREEN_PAUSE_E2E_URL

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof import("../../../../scripts/lib/headless-browser.mjs")["launchHeadless"]>>["newPage"]>>

/** Play state of every CSS animation on the page, grouped by the `data-where` copy it belongs to. */
const playStates = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string[]> = {}
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target
      const where = target?.closest("[data-where]")?.getAttribute("data-where") ?? "?"
      ;(out[where] ??= []).push(animation.playState)
    }
    for (const states of Object.values(out)) states.sort()
    return out
  })

/** Polls until `check` passes: the observer reports a crossing a frame or so after it happens. */
async function eventually(page: Page, check: (states: Record<string, string[]>) => boolean): Promise<Record<string, string[]>> {
  let states: Record<string, string[]> = {}
  for (let i = 0; i < 40; i++) {
    states = await playStates(page)
    if (check(states)) return states
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return states
}

const ALL = (state: string) => (states: string[] | undefined) => !!states?.length && states.every((s) => s === state)
// Each copy is two dots (the dot and its two rings: three animations each) and one spinner: seven.
const COPY = 7

test("a live dot or spinner out of view is paused, and runs again once scrolled in", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = (await browser.newPage()) as Page
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 700, height: 500, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/offscreen-pause-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-where='page-below'] [data-box-spinner]")

    let states = await eventually(page, (s) => ALL("paused")(s["page-below"]) && ALL("paused")(s["panel-below"]))
    assert.equal(states["in-view"]?.length, COPY, "every mark in view animates")
    assert.ok(ALL("running")(states["in-view"]), `in view: ${states["in-view"]}`)
    assert.ok(ALL("paused")(states["page-below"]), `below the page's fold: ${states["page-below"]}`)
    assert.ok(ALL("paused")(states["panel-below"]), `below the panel's fold: ${states["panel-below"]}`)
    assert.equal(states["page-below"]?.length, COPY)

    // Scrolled in, both copies run; the one now scrolled away holds still.
    await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("[data-panel]")!
      panel.scrollTop = panel.scrollHeight
      document.querySelector("[data-where='page-below']")!.scrollIntoView({ block: "center" })
    })
    states = await eventually(page, (s) => ALL("running")(s["page-below"]) && ALL("paused")(s["in-view"]))
    assert.ok(ALL("running")(states["page-below"]), `scrolled in: ${states["page-below"]}`)
    assert.ok(ALL("paused")(states["in-view"]), `scrolled away: ${states["in-view"]}`)

    // The panel's copy runs once its own scroller brings it in, with the page back at the top.
    await page.evaluate(() => window.scrollTo(0, 0))
    states = await eventually(page, (s) => ALL("running")(s["panel-below"]) && ALL("running")(s["in-view"]))
    assert.ok(ALL("running")(states["panel-below"]), `scrolled into its panel: ${states["panel-below"]}`)
    assert.ok(ALL("running")(states["in-view"]), `back in view: ${states["in-view"]}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
