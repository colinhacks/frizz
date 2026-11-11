import assert from "node:assert/strict"
import test from "node:test"
import type { CDPSession, Page } from "puppeteer"

// A SHEET OPENED OVER A BOARD WITH NOTHING TO SCROLL LEAVES THE BOARD ALONE (App.tsx's page lock).
//
// The lock pins `body{position:fixed; top:-y}` while any overlay is open, so the page cannot scroll under
// it. A desktop board is the one-thread pane, exactly one window tall, so there is nothing to hold — and
// the pin re-laid-out the whole board and moved all of it into one new fixed-position compositor layer
// the instant Settings or a sheet opened. It was the only thing opening a sheet did to everything beneath
// it, which the maintainer saw intermittently stop rendering under an open drawer (2026-11-10). This pins
// both halves: the board is untouched under a sheet, in the DOM and on the compositor, and a page that
// CAN scroll is still locked and handed back where it was.
//
// Opt-in: it drives a real Frizz and Chrome. Against a disposable stack (the frizz-stack skill), with any
// thread on the board:
//
//   nub scripts/adhoc-stack.mjs --port=47731 --project=/abs/throwaway-repo \
//     --claude-bin=$PWD/scripts/scripted-claude.mjs > /tmp/stack.log 2>&1      # background
//   (dispatch one thread, e.g. "[script ending=question paras=6] Page lock", through scripts/lib/rpc-client.mjs)
//   FRIZZ_PAGE_LOCK_E2E_URL=http://127.0.0.1:47731/project/<slug> FRIZZ_PAGE_LOCK_E2E_SLUG=<thread slug> \
//     nub run test packages/web/src/components/pageLockUnderSheets.e2e.test.ts
const baseUrl = process.env.FRIZZ_PAGE_LOCK_E2E_URL
const slug = process.env.FRIZZ_PAGE_LOCK_E2E_SLUG

// adhoc-stack runs without the launcher supervisor; only its status probe is answered here.
async function stubSupervisorStatus(page: Page): Promise<void> {
  await page.setRequestInterception(true)
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/_frizz/control/status") {
      void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
    } else void request.continue()
  })
}

function bodyLock(page: Page): Promise<{ inline: string; computed: string; top: string; scrollY: number }> {
  return page.evaluate(() => ({
    inline: document.body.style.position,
    computed: getComputedStyle(document.body).position,
    top: document.body.style.top,
    scrollY: window.scrollY,
  }))
}

// Why the compositor put the element under `selector` on a layer of its own, read from the DevTools
// LayerTree: the board's pane column scrolls with the root on a page at rest, and the body pin turned it
// into `FixedPosition`. Empty when the element paints into an ancestor's layer.
async function compositingReasons(page: Page, cdp: CDPSession, selector: string): Promise<string[]> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 })
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector })
  assert.ok(nodeId, `${selector} is on the page`)
  const { node } = await cdp.send("DOM.describeNode", { nodeId })
  // A fresh tree: LayerTree reports the whole tree on every change, and the last report is the current one.
  let layers: { layerId: string; backendNodeId?: number }[] = []
  const onChange = (event: { layers?: typeof layers }) => { if (event.layers) layers = event.layers }
  cdp.on("LayerTree.layerTreeDidChange", onChange)
  await cdp.send("LayerTree.disable").catch(() => {})
  await cdp.send("LayerTree.enable")
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await new Promise((resolve) => setTimeout(resolve, 300))
  cdp.off("LayerTree.layerTreeDidChange", onChange)
  const layer = layers.find((l) => l.backendNodeId === node.backendNodeId)
  if (!layer) return []
  const { compositingReasonIds = [] } = await cdp.send("LayerTree.compositingReasons", { layerId: layer.layerId })
  return compositingReasonIds
}

test("a sheet over a page with nothing to scroll does not pin the body; a page that scrolls is still locked", {
  skip: !baseUrl || !slug,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await stubSupervisorStatus(page)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900 })
    const cdp = await page.createCDPSession()
    await cdp.send("DOM.enable")

    // THE DESKTOP BOARD: the thread in its pane, one window tall.
    await page.goto(`${baseUrl}?thread=${slug}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-pane-thread] [data-thread-surface]")
    const paneBefore = await page.$eval("[data-pane-thread]", (el) => el.getBoundingClientRect().toJSON())
    const reasonsBefore = await compositingReasons(page, cdp, "[data-pane-thread]")
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), true, "the pane board is one window tall")

    await page.click('button[aria-label="Settings"]')
    await page.waitForSelector("[data-modal-surface]")
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await bodyLock(page), { inline: "", computed: "static", top: "", scrollY: 0 }, "Settings left the board's body where it was")
    assert.deepEqual(await page.$eval("[data-pane-thread]", (el) => el.getBoundingClientRect().toJSON()), paneBefore, "the pane did not move")
    const reasonsUnder = await compositingReasons(page, cdp, "[data-pane-thread]")
    assert.ok(!reasonsUnder.includes("FixedPosition"), `the pane stayed off the fixed-position path (was ${reasonsBefore.join(",")}, now ${reasonsUnder.join(",")})`)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-modal-surface]"))

    // A THREAD SHEET over a short status list: also nothing to scroll, also untouched.
    await page.goto(`${baseUrl}/status/active?thread=${slug}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector(".frizz-sheet-panel [data-thread-surface]")
    if (await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)) {
      assert.deepEqual(await bodyLock(page), { inline: "", computed: "static", top: "", scrollY: 0 }, "a sheet over a short list left the body alone")
    }
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector(".frizz-sheet-panel"))

    // THE CONTROL: the same list made taller than the window and scrolled. The lock holds the page there
    // while Settings is open, and the page comes back to the same place when it closes.
    await page.evaluate(() => {
      const spacer = document.createElement("div")
      spacer.style.height = "2400px"
      spacer.dataset.pageLockSpacer = ""
      document.getElementById("workpane")?.append(spacer)
    })
    await page.evaluate(() => window.scrollTo(0, 600))
    await page.waitForFunction(() => window.scrollY === 600)
    await page.click('button[aria-label="Settings"]')
    await page.waitForSelector("[data-modal-surface]")
    await page.waitForFunction(() => document.body.style.position === "fixed")
    assert.deepEqual(await bodyLock(page), { inline: "fixed", computed: "fixed", top: "-600px", scrollY: 0 }, "a page that scrolls is still pinned at its offset")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-modal-surface]") && document.body.style.position === "")
    assert.equal((await bodyLock(page)).scrollY, 600, "closing hands the page back where it was")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
