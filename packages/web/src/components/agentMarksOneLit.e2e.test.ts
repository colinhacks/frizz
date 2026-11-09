import assert from "node:assert/strict"
import test from "node:test"

// The gauge and the plug beside a prompt box's model chip overlap a little, so neither target gives up width to a
// gap, and only one of them is ever lit (maintainer 2026-11-09: "it shouldn't be possible to hover in the middle of
// them and have them both show up at once"). Which element takes the pointer in the shared band, when a hover-opened
// panel shuts, and what is actually painted frame by frame are all the browser's to say, so this moves a real
// pointer over the real marks.
//
//   cd packages/web && nubx vite --port 5947 --strictPort
//   FRIZZ_QUOTA_GAUGE_E2E_URL=http://127.0.0.1:5947 nub run test packages/web/src/components/agentMarksOneLit.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUOTA_GAUGE_E2E_URL

const GAUGE = "[data-quota-gauge]"
const PLUG = "[data-mcp-plug]"
const PANEL = "[data-quota-panel]"
const MENU = "[data-mcp-menu]"

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof import("../../../../scripts/lib/headless-browser.mjs")["launchHeadless"]>>["newPage"]>>

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

/** Which marks paint a fill right now. Computed, so a fill part-way through a transition counts. */
const lit = (page: Page) =>
  page.evaluate((gauge, plug) => {
    const painted = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor !== "rgba(0, 0, 0, 0)"
    return [painted(gauge) && "gauge", painted(plug) && "plug"].filter(Boolean)
  }, GAUGE, PLUG)

/** Runs `gesture`, reading the marks on every animation frame, and returns the most that were lit in one frame. */
async function mostLitDuring(page: Page, gesture: () => Promise<void>): Promise<number> {
  await page.evaluate((gauge, plug) => {
    const state = window as unknown as { __mostLit: number; __sampling: boolean }
    state.__mostLit = 0
    state.__sampling = true
    const painted = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor !== "rgba(0, 0, 0, 0)"
    const tick = () => {
      state.__mostLit = Math.max(state.__mostLit, [gauge, plug].filter(painted).length)
      if (state.__sampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, GAUGE, PLUG)
  await gesture()
  return page.evaluate(() => {
    const state = window as unknown as { __mostLit: number; __sampling: boolean }
    state.__sampling = false
    return state.__mostLit
  })
}

async function withMarks(run: (page: Page, boxes: { gauge: DOMRect; plug: DOMRect; y: number }) => Promise<void>) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = (await browser.newPage()) as Page
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 700, height: 500, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/status-row-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-agent-marks] ${GAUGE}`)
    await page.waitForSelector(`[data-agent-marks] ${PLUG}`)
    await page.mouse.move(10, 480)
    const [gauge, plug] = (await page.evaluate((a, b) => [a, b].map((s) => document.querySelector(s)!.getBoundingClientRect().toJSON()), GAUGE, PLUG)) as [DOMRect, DOMRect]
    await run(page, { gauge, plug, y: gauge.top + gauge.height / 2 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}

test("every pixel from the gauge's left edge to the plug's right edge belongs to one of them", { skip: !baseUrl, timeout: 90_000 }, async () => {
  await withMarks(async (page, { gauge, plug, y }) => {
    assert.ok(plug.left < gauge.right, `the squares overlap: the gauge ends at ${gauge.right}, the plug starts at ${plug.left}`)
    const dead = await page.evaluate((from, to, row, a, b) => {
      const misses: number[] = []
      for (let x = from; x < to; x += 0.5) if (!document.elementFromPoint(x, row)?.closest(`${a},${b}`)) misses.push(x)
      return misses
    }, gauge.left + 1, plug.right - 1, y, GAUGE, PLUG)
    assert.deepEqual(dead, [], "no column between the two marks is dead")
  })
})

test("the pointer in the band they share lights exactly one, however it got there", { skip: !baseUrl, timeout: 90_000 }, async () => {
  await withMarks(async (page, { gauge, plug, y }) => {
    const band = (plug.left + gauge.right) / 2

    // Across the gauge, whose panel opens on the way past.
    await page.mouse.move(gauge.left + gauge.width / 3, y)
    await page.waitForSelector(PANEL)
    assert.deepEqual(await lit(page), ["gauge"], "the gauge alone, with the pointer on it")
    const fromGauge = await mostLitDuring(page, async () => {
      await page.mouse.move(band, y)
      await settle()
    })
    assert.equal(fromGauge, 1, "never two at once, on any frame of the move from the gauge into the band")
    assert.deepEqual(await lit(page), ["plug"], "the band belongs to the plug, which is later in the document")
    assert.equal(await page.$(PANEL), null, "the gauge's panel has shut")

    // Across the plug, then straight back out of the band to the gauge.
    await page.mouse.move(10, 480)
    await settle()
    await page.mouse.move(plug.right - 4, y)
    await settle(200)
    await page.mouse.move(band, y)
    await settle()
    assert.deepEqual(await lit(page), ["plug"], "arriving from the plug's side")
    const toGauge = await mostLitDuring(page, async () => {
      await page.mouse.move(gauge.left + gauge.width / 3, y)
      await settle()
    })
    assert.equal(toGauge, 1, "never two at once on the way back")
    assert.deepEqual(await lit(page), ["gauge"])

    // Straight down into the band from above, touching neither first.
    await page.mouse.move(10, 480)
    await settle()
    await page.mouse.move(band, gauge.top - 30)
    await page.mouse.move(band, y)
    await settle()
    assert.deepEqual(await lit(page), ["plug"], "arriving from above")
  })
})

test("with the plug's menu open the gauge stays quiet under the pointer, and a click on it takes over", { skip: !baseUrl, timeout: 90_000 }, async () => {
  await withMarks(async (page, { gauge, plug, y }) => {
    await page.mouse.move(plug.right - 6, y)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForSelector(MENU)
    assert.deepEqual(await lit(page), ["plug"])

    const most = await mostLitDuring(page, async () => {
      await page.mouse.move(gauge.left + gauge.width / 3, y)
      await settle()
    })
    assert.equal(most, 1, "the gauge lights nothing while the plug's menu is open")
    assert.deepEqual(await lit(page), ["plug"])
    assert.equal(await page.$(PANEL), null, "and opens no second panel over the menu")
    assert.notEqual(await page.$(MENU), null, "a hover does not dismiss a menu the operator clicked open")

    await page.mouse.down()
    await page.mouse.up()
    await page.waitForSelector(PANEL)
    await settle()
    assert.equal(await page.$(MENU), null, "a click on the gauge shuts the plug's menu")
    assert.deepEqual(await lit(page), ["gauge"])
  })
})
