import assert from "node:assert/strict"
import test, { after } from "node:test"

// Runtime coverage for the render-error boundaries. Skipped unless a Vite URL serving the fixtures is
// provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and set
// FRIZZ_ERROR_BOUNDARY_E2E_URL to its origin.
//
// The bug these exist for produced a BLANK WINDOW, so "the page is not blank" is the assertion that
// matters and it can only be made in a real browser — a server-rendered string cannot show that React
// tore the root down. error-boundary-fixture.tsx throws the real production shape (a free identifier
// left by an artifact built from a torn tree → ReferenceError on first render).
const baseUrl = process.env.FRIZZ_ERROR_BOUNDARY_E2E_URL

// ONE browser for the whole file, a fresh page per test. Launching Chrome four times cost more than
// every assertion here put together and pushed individual tests past their timeout on a machine
// running other agents' QA — a flake with no bearing on what is being tested.
let shared: Promise<import("puppeteer").Browser> | null = null
async function browser() {
  if (!shared) {
    shared = import("../../../../scripts/lib/headless-browser.mjs").then((m) => m.launchHeadless())
  }
  return shared
}
after(async () => {
  if (shared) await (await shared).close()
})

async function open(path: string) {
  const page = await (await browser()).newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" })
  return page
}

// THE CONTROL for every assertion below it. The same throw with no boundary around it must still
// blank the window — otherwise "the page rendered" would prove nothing about the boundaries, and a
// future React that recovers on its own would leave these tests passing for the wrong reason.
test("without a boundary the same throw still empties the root — the failure this fixes is real", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const page = await open("/error-boundary-fixture.html?case=unguarded")
  try {
    await page.waitForFunction(() => document.getElementById("root")!.childElementCount === 0)
    assert.equal(await page.evaluate(() => document.body.textContent?.trim()), "")
  } finally {
    await page.close()
  }
})

test("a drawer that throws is contained in its own layer — the board survives and the drawer closes", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const page = await open("/error-boundary-fixture.html?case=drawer")
  try {
    await page.waitForSelector("[data-error-panel]")

    const contained = await page.evaluate(() => ({
      // THE regression: before the boundaries, a drawer throw emptied #root entirely.
      rootChildren: document.getElementById("root")!.childElementCount,
      boardOnScreen: Boolean(document.querySelector("[data-fixture-board]")),
      // The crashing body must never have committed any of its own output.
      crashedBodyRendered: Boolean(document.querySelector("[data-never-rendered]")),
      panelText: document.querySelector("[data-error-panel]")!.textContent ?? "",
      header: document.body.textContent?.includes("This drawer could not be rendered") ?? false,
    }))
    assert.ok(contained.rootChildren > 0, "the app root must not be torn down by a drawer render error")
    assert.ok(contained.boardOnScreen, "the board underneath the crashed drawer must stay mounted")
    assert.equal(contained.crashedBodyRendered, false)
    assert.ok(contained.header, "the fallback keeps the drawer's own sheet chrome (and its close button)")
    // The operator is the person who will fix this, so the actual error has to be ON the card.
    assert.match(contained.panelText, /Something went wrong rendering this drawer\./)
    assert.match(contained.panelText, /ReferenceError/)

    // Close dismisses the broken layer and leaves the board behind it working.
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-error-panel] button")]
      buttons.find((b) => b.textContent?.trim() === "Close")!.click()
    })
    await page.waitForFunction(() => !document.querySelector("[data-error-panel]"))
    assert.ok(await page.evaluate(() => Boolean(document.querySelector("[data-fixture-board]"))))
  } finally {
    await page.close()
  }
})

test("a throwing workpane falls back to a panel in place, not a blank page", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const page = await open("/error-boundary-fixture.html?case=panel")
  try {
    await page.waitForSelector("[data-fixture-panel] [data-error-panel]")
    const text = await page.evaluate(() => document.querySelector("[data-error-panel]")!.textContent ?? "")
    assert.match(text, /Something went wrong rendering the queue\./)
    assert.match(text, /ReferenceError/)
    // Try again / Reload Frizz are the two ways out and both must be offered.
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll("[data-error-panel] button")].map((b) => b.textContent?.trim() ?? ""),
    )
    assert.deepEqual(labels, ["Try again", "Reload Frizz"])
  } finally {
    await page.close()
  }
})

test("the root boundary is the last resort — a throw above every surface still renders a readable page", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const page = await open("/error-boundary-fixture.html?case=root")
  try {
    await page.waitForSelector("[data-error-panel]")
    const state = await page.evaluate(() => ({
      rootChildren: document.getElementById("root")!.childElementCount,
      text: document.querySelector("[data-error-panel]")!.textContent ?? "",
    }))
    assert.ok(state.rootChildren > 0)
    assert.match(state.text, /Something went wrong rendering Frizz\./)
    assert.match(state.text, /ReferenceError/)
  } finally {
    await page.close()
  }
})
