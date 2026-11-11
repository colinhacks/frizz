import assert from "node:assert/strict"
import test from "node:test"
import type { CDPSession, Page } from "puppeteer"

// A SHEET ON A DESKTOP LEAVES THE PAGE UNDER IT ALONE (App.tsx's page lock).
//
// While any overlay is open the page must not scroll. Until 2026-11-10 every device locked it by pinning
// `body{position:fixed; top:-y}`, which re-laid-out the whole board and moved all of it into one new
// fixed-position compositor layer the instant Settings or a sheet opened. The maintainer saw the board
// under an open drawer go to plain background where the sidebar and the thread had been, and come back
// only when the drawer closed (2026-11-10). A desktop now locks with `overflow: hidden` on the body, which
// moves nothing; the phone keeps the pin, which iOS needs. This pins all three: the one-window pane board
// under Settings, a SCROLLED page under a thread sheet (in the DOM, on the compositor, and against the
// wheel), and the phone's pin as the control.
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

function bodyLock(page: Page): Promise<{ inline: string; computed: string; top: string; overflow: string; scrollY: number }> {
  return page.evaluate(() => ({
    inline: document.body.style.position,
    computed: getComputedStyle(document.body).position,
    top: document.body.style.top,
    overflow: document.body.style.overflow,
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

test("a sheet on a desktop locks the page without moving it, scrolled or not; the phone still pins", {
  skip: !baseUrl || !slug,
  timeout: 120_000,
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

    // THE DESKTOP BOARD: the thread in its pane, one window tall, under Settings.
    await page.goto(`${baseUrl}?thread=${slug}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-pane-thread] [data-thread-surface]")
    const paneBefore = await page.$eval("[data-pane-thread]", (el) => el.getBoundingClientRect().toJSON())
    const reasonsBefore = await compositingReasons(page, cdp, "[data-pane-thread]")
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), true, "the pane board is one window tall")

    await page.click('button[aria-label="Settings"]')
    await page.waitForSelector("[data-modal-surface]")
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await bodyLock(page), { inline: "", computed: "static", top: "", overflow: "hidden", scrollY: 0 }, "Settings locked the page without pinning the body")
    assert.deepEqual(await page.$eval("[data-pane-thread]", (el) => el.getBoundingClientRect().toJSON()), paneBefore, "the pane did not move")
    const reasonsUnder = await compositingReasons(page, cdp, "[data-pane-thread]")
    assert.ok(!reasonsUnder.includes("FixedPosition"), `the pane stayed off the fixed-position path (was ${reasonsBefore.join(",")}, now ${reasonsUnder.join(",")})`)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-modal-surface]") && document.body.style.overflow === "")

    // A SCROLLED PAGE UNDER A THREAD SHEET — the maintainer's case: a status list made taller than the
    // window, scrolled 600px, then the thread opened over it. Nothing under the sheet moves, nothing joins
    // the fixed-position path, the wheel does not scroll it, and closing leaves it where it was.
    await page.goto(`${baseUrl}/status/active`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("#workpane aside, aside")
    await page.evaluate(() => {
      const spacer = document.createElement("div")
      spacer.style.height = "2400px"
      spacer.dataset.pageLockSpacer = ""
      document.getElementById("workpane")?.append(spacer)
    })
    await page.evaluate(() => window.scrollTo(0, 600))
    await page.waitForFunction(() => window.scrollY === 600)
    const under = () => page.evaluate(() => ({
      sidebar: document.querySelector("aside")!.getBoundingClientRect().toJSON(),
      workpane: document.getElementById("workpane")!.getBoundingClientRect().toJSON(),
    }))
    const before = await under()
    const sidebarReasonsBefore = await compositingReasons(page, cdp, "aside")
    // Opened the way the app opens it, by the URL the router writes.
    await page.evaluate((thread) => {
      history.pushState(null, "", `${location.pathname}?thread=${thread}`)
      dispatchEvent(new PopStateEvent("popstate"))
    }, slug!)
    await page.waitForSelector(".frizz-sheet-panel [data-thread-surface]")
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await bodyLock(page), { inline: "", computed: "static", top: "", overflow: "hidden", scrollY: 600 }, "the page holds its offset without a pin")
    assert.deepEqual(await under(), before, "the sidebar and the list did not move under the sheet")
    const sidebarReasonsUnder = await compositingReasons(page, cdp, "aside")
    assert.ok(!sidebarReasonsUnder.includes("FixedPosition"), `the sidebar stayed off the fixed-position path (was ${sidebarReasonsBefore.join(",")}, now ${sidebarReasonsUnder.join(",")})`)
    await page.mouse.move(300, 450)
    await page.mouse.wheel({ deltaY: 500 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal((await bodyLock(page)).scrollY, 600, "the wheel over the board does not scroll the page under the sheet")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector(".frizz-sheet-panel") && document.body.style.overflow === "")
    assert.equal((await bodyLock(page)).scrollY, 600, "closing leaves the page where it was")
    assert.deepEqual(await under(), before)

    // THE PHONE, THE CONTROL: it keeps the pin, which iOS needs, at the page's offset, and hands the page back.
    const phone = await browser.newPage()
    await stubSupervisorStatus(phone)
    phone.on("pageerror", (error) => errors.push(String(error)))
    await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await phone.goto(baseUrl!, { waitUntil: "domcontentloaded" })
    await phone.waitForSelector("[data-mobile-board]")
    await phone.evaluate(() => {
      const spacer = document.createElement("div")
      spacer.style.height = "2400px"
      document.querySelector("[data-mobile-board]")!.append(spacer)
    })
    await phone.evaluate(() => window.scrollTo(0, 300))
    await phone.waitForFunction(() => window.scrollY === 300)
    await phone.evaluate((thread) => {
      history.pushState(null, "", `${location.pathname}?thread=${thread}`)
      dispatchEvent(new PopStateEvent("popstate"))
    }, slug!)
    await phone.waitForFunction(() => document.body.style.position === "fixed", { timeout: 15_000 })
    // The inline pin, not the computed position: the phone's sheet is a modal Radix dialog, whose own scroll
    // lock (`body[data-scroll-locked]`) holds the body `position: relative !important` while it is open.
    const pinned = await bodyLock(phone)
    assert.deepEqual({ inline: pinned.inline, top: pinned.top, overflow: pinned.overflow }, { inline: "fixed", top: "-300px", overflow: "" }, "the phone pins the page at its offset")
    await phone.goBack()
    await phone.waitForFunction(() => document.body.style.position === "", { timeout: 15_000 })
    assert.equal((await bodyLock(phone)).scrollY, 300, "and hands it back where it was")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
