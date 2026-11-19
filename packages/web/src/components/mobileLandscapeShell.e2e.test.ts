import assert from "node:assert/strict"
import test from "node:test"

// A PHONE HELD SIDEWAYS GETS THE PHONE SHELL (lib/mobile.ts). It is 844 to 956px wide there, so until
// 2026-11-19 the width-only breakpoint handed it the desktop: a rail, a sidebar with room for two queue
// rows under its prompt box, and a pane of mouse-sized controls, in 393px of height. Three things had to
// agree for the fix and each is asserted below: the shell (MOBILE_QUERY), the classes (`phone:`, which
// hides the rail and drops its inset), and the drawer's narrow rule (ui/Sheet), which makes the
// full-screen thread a modal.
//
// The board URL of an isolated adhoc-stack with at least one thread, never a live board:
//   nub scripts/adhoc-stack.mjs --port=<port> --seed
//   FRIZZ_MOBILE_LANDSCAPE_E2E_URL=http://127.0.0.1:<port>/project/<slug> nub run test <this file>
const url = process.env.FRIZZ_MOBILE_LANDSCAPE_E2E_URL

test("a phone held sideways draws the phone shell, and a desktop or tablet of the same width does not", { skip: !url, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    const load = async (viewport: { width: number; height: number; touch: boolean }, path = url!) => {
      await page.setViewport({ width: viewport.width, height: viewport.height, isMobile: viewport.touch, hasTouch: viewport.touch })
      await page.goto(path, { waitUntil: "networkidle2" })
      await page.waitForSelector("[data-mobile-board], [data-status-row]")
      return page.evaluate(() => {
        const board = document.querySelector("[data-mobile-board]")
        const rail = document.querySelector("nav[aria-label=\"Projects\"]")
        return {
          coarse: matchMedia("(pointer: coarse)").matches,
          phone: board !== null,
          boardLeft: board ? Math.round(board.getBoundingClientRect().left) : null,
          boardWidth: board ? Math.round(board.getBoundingClientRect().width) : null,
          railShown: rail !== null && getComputedStyle(rail).display !== "none" && rail.getBoundingClientRect().width > 0,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }
      })
    }

    // The phone, sideways: its shell from edge to edge, with no rail under the header and no inset for one.
    for (const [width, height] of [[844, 390], [852, 393], [956, 440]] as const) {
      const sideways = await load({ width, height, touch: true })
      assert.equal(sideways.coarse, true, "the emulated phone has a coarse pointer")
      assert.deepEqual(
        { phone: sideways.phone, boardLeft: sideways.boardLeft, boardWidth: sideways.boardWidth, railShown: sideways.railShown, overflow: sideways.overflow },
        { phone: true, boardLeft: 0, boardWidth: width, railShown: false, overflow: false },
        `${width}x${height} touch`,
      )
    }

    // Its thread is the whole screen and a modal, as in portrait.
    await load({ width: 852, height: 393, touch: true })
    await page.waitForSelector("[data-mobile-thread-row]")
    await page.tap("[data-mobile-thread-row]")
    await page.waitForSelector("[data-mobile-thread-back]", { visible: true })
    await page.waitForFunction(() => {
      const panel = document.querySelector("[data-mobile-thread-back]")?.closest("[role='dialog']")
      return !!panel && !panel.getAnimations().some((animation) => animation.playState === "running")
    })
    const sheet = await page.$eval("[data-mobile-thread-back]", (el) => {
      const panel = el.closest("[role='dialog']")!
      const rect = panel.getBoundingClientRect()
      return { modal: panel.getAttribute("aria-modal"), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
    })
    assert.deepEqual(sheet, { modal: "true", left: 0, width: 852, height: 393 })

    // The same window with a mouse is a short desktop window, and a tablet on its side is a tablet.
    const shortDesktop = await load({ width: 852, height: 393, touch: false })
    assert.deepEqual({ coarse: shortDesktop.coarse, phone: shortDesktop.phone }, { coarse: false, phone: false }, "852x393 with a fine pointer keeps the desktop shell")
    const tablet = await load({ width: 1024, height: 768, touch: true })
    assert.deepEqual({ coarse: tablet.coarse, phone: tablet.phone }, { coarse: true, phone: false }, "a 1024x768 touch screen keeps the desktop shell")
    // And portrait is what it was.
    const portrait = await load({ width: 390, height: 844, touch: true })
    assert.deepEqual({ phone: portrait.phone, boardWidth: portrait.boardWidth, railShown: portrait.railShown }, { phone: true, boardWidth: 390, railShown: false })

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
