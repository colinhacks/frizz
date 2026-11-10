import assert from "node:assert/strict"
import test from "node:test"

// The update popover and its failure card hang off the status row, inside the sticky sidebar column, and
// spill out over the workpane beside it. A sticky box is a stacking context whatever its z-index, so while
// the panels stacked themselves in the row (`absolute z-50`) they ranked only against the sidebar and went
// UNDER the queue cards' sticky headers, and under a thread drawer entirely (maintainer 2026-10-30, on the
// Console: "Z-index issues"). The queue cards gave way to the one-thread pane on 2026-11-09, so the board
// is now read with a thread open in its pane, whose column the panel spills across. A desktop board
// opens no drawer, so the drawer is opened over a status list (`/status/<status>?thread=<slug>`). Unit
// markup cannot see paint order; this asks the browser what is on top.
//
// Point at the BOARD URL of an isolated adhoc-stack seeded with queued and snoozed threads. Only
// the supervisor is simulated, and its update POST is answered without touching anything:
//   nub scripts/adhoc-stack.mjs --port=47391 --also-project=/abs/throwaway-repo > stack.log 2>&1
//   nub scripts/seed-console-bands.mjs --home=<home> --project=<launcher.id>=<launcher.dir> \
//     --project=<tenants[0].id>=<tenants[0].dir> --done=2,2
//   FRIZZ_UPDATE_POPOVER_E2E_URL=<url from stack.log> nub run test packages/web/src/components/updatePopoverStacking.e2e.test.ts
// Measured on unfixed main, 2026-10-30: 23 of 128 points of the popover covered on the Console and on the
// board, 70 with a drawer open, 27 of the failure card's.
const url = process.env.FRIZZ_UPDATE_POPOVER_E2E_URL

/** Points across the panel where something OTHER than the panel is the topmost element. */
function coveredPoints(selector: string) {
  const panel = document.querySelector(selector)
  if (!panel) return { covered: -1, by: [] as string[] }
  // The panel's own wrapper shows past its rounded corners; it is the panel, not something over it.
  const own = panel.parentElement!
  const r = panel.getBoundingClientRect()
  const by: string[] = []
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 8; j++) {
      const x = r.left + 3 + ((r.width - 6) * i) / 15
      const y = r.top + 3 + ((r.height - 6) * j) / 7
      const el = document.elementFromPoint(x, y)
      if (el && !own.contains(el)) by.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")}`)
    }
  }
  return { covered: by.length, by: [...new Set(by)] }
}

test("nothing paints over the update popover or its failure card", { skip: !url, timeout: 180_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 60_000 })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    let failed = false
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (path === "/_frizz/control/status") {
        const body = failed
          ? { protocol: 1, state: "failed", message: "Command failed: nub run typecheck\nsrc/groups.ts(440,27): error TS2304: Cannot find name 'restedQueueHandoff'." }
          : { protocol: 1, state: "ready", updateRestart: true, updateAvailable: true, version: "0.15.38", updateVersion: "0.15.40" }
        return void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
      }
      if (path === "/_frizz/control/update-restart") {
        failed = true
        return void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "restarting" }) })
      }
      return void request.continue()
    })
    await page.setViewport({ width: 1440, height: 900 })
    const origin = new URL(url!).origin
    const button = '[data-status-row] button[aria-label="Update Frizz"]'

    const popoverOver = async (where: string) => {
      await page.mouse.move(1300, 850)
      await page.waitForFunction(() => document.querySelector("#update-restart-popover") === null)
      await (await page.waitForSelector(button))!.hover()
      await page.waitForSelector("#update-restart-popover")
      // Something has to sit behind the panel for the test to be fair.
      assert.ok(await page.$("[data-sidebar-item]") || await page.$("[data-console-sidebar]"), `${where}: a board behind the panel`)
      assert.deepEqual(await page.evaluate(coveredPoints, "#update-restart-popover"), { covered: 0, by: [] }, `${where}: the popover is on top`)
      // Leaving the button still shuts it: the panel left the row, the hover did not change.
      await page.mouse.move(1300, 850)
      await page.waitForFunction(() => document.querySelector("#update-restart-popover") === null)
    }

    // Where the maintainer saw it, then a project's own board, then with a thread open in that board's
    // pane (at 1440px the panel's right half lies over the thread's column), then with a thread's drawer
    // open beside the sidebar, over a status list, the one board view with no pane.
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    const board = url!.replace(/\/$/, "")
    await page.goto(`${origin}/console`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-console-sidebar]")
    await page.waitForSelector("[data-sidebar-item]")
    await popoverOver("the Console")
    await page.goto(url!, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-sidebar-item]")
    await popoverOver("a project board")
    await page.goto(`${board}?thread=queued-0`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-pane-thread] [data-thread-header]")
    await popoverOver("a thread in the pane")
    await page.goto(`${board}/status/active?thread=snoozed-0`, { waitUntil: "networkidle2" })
    await page.waitForSelector(".frizz-sheet-panel")
    await popoverOver("a thread drawer")

    // The failure card stays up after the "failed" poll, hanging off the same anchor.
    await page.goto(`${origin}/console`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-sidebar-item]")
    await page.click(button)
    await page.waitForSelector('[role="alert"]', { visible: true, timeout: 30_000 })
    await page.mouse.move(1300, 850)
    assert.deepEqual(await page.evaluate(coveredPoints, '[role="alert"]'), { covered: 0, by: [] }, "the failure card is on top")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
