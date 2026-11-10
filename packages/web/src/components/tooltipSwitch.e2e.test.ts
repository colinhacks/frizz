import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_TOOLTIP_SWITCH_E2E_URL

// Icon verbs sit shoulder to shoulder, and the tooltip has to name the one you are actually pointing
// at. It did not: hovering Restart worker and then sliding onto the icon beside it left the RESTART
// label up while the pointer sat squarely on the neighbour (maintainer 2026-08-06: "the popover
// associated with the restart button continued to show up. It didn't switch over"). The neighbour was
// a Reload plugins button then, in the lifecycle footer; Restart worker has been in the thread
// header's action strip since 2026-08-26, and that button is gone. The gesture and the bug are
// properties of two adjacent triggers, not of the surface or of which two, so this drives Restart
// worker and the Collapse icon on its left.
//
// The cause was NOT the thing it looks like. In the footer the two marks wore negative ink trims
// that overlapped their 24px hover squares by 3px, which was the obvious suspect and the wrong one —
// the bug was gone with the overlap still there, and it is gone now with no overlap at all (the header
// strip is untrimmed 28px squares). Instrumenting the triggers showed the DOM doing everything right:
// `pointerleave` on Restart and `pointerenter` on its neighbour both fired, at the same x. Radix was
// declining to switch, because `Tooltip.Provider` defaults to
// HOVERABLE CONTENT and holds a tooltip open while the pointer is inside the grace polygon between
// the trigger and its content — and this content is a wide box sitting directly above BOTH icons, so
// the neighbour is inside the polygon. `disableHoverableContent` on the provider is the fix; nothing
// in frizz needs to hover INTO a tooltip, and the ones that must stay reachable on touch use the
// clickable branch, which is not Radix at all.
//
// Driven with real pointer movement rather than dispatched events, because that distinction is the
// whole bug: synthetic `mouseover` would have "passed" against the broken build.
//
// Opt-in like this repo's other e2e tests — point it at a vite server for packages/web:
//   npx vite --port 5799 --strictPort   (in packages/web)
//   FRIZZ_TOOLTIP_SWITCH_E2E_URL=http://localhost:5799 nub run test \
//     'packages/web/src/components/tooltipSwitch.e2e.test.ts'
test("the tooltip names whichever icon verb the pointer is on, including the neighbour it slid from", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  // A bare `vite` over packages/web serves no favicon, and the 404 it logs says nothing about the
  // app — this test is opt-in against whatever server the runner points it at, so it ignores exactly
  // that one line and still fails on any real console error. The URL is on the message's LOCATION,
  // not in its text: the text is the generic "Failed to load resource…", so matching on the text
  // silently ignores nothing at all.
  const noise = (message: { text(): string; location(): { url?: string } }) =>
    message.location().url?.endsWith("/favicon.ico") ?? false
  page.on("console", (message) => { if (message.type() === "error" && !noise(message)) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/icon-rhythm-fixture.html`, { waitUntil: "networkidle0" })

    const centres = await page.evaluate(() => {
      const centre = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`the icon-rhythm fixture is missing ${selector}`)
        const box = el.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      return { collapse: centre('[aria-label="Collapse"]'), restart: centre('[aria-label="Restart worker"]') }
    })

    // Whichever verb the pointer is over, and what the one open tooltip says — asserted together, so
    // a tooltip that is merely *absent* cannot pass as a tooltip that switched.
    const pointing = () =>
      page.evaluate(() => {
        const tooltip = document.querySelector('[role="tooltip"]')
        return {
          label: (tooltip?.textContent ?? "").trim().split("—")[0]?.trim() ?? null,
          open: document.querySelectorAll('[role="tooltip"]').length,
        }
      })

    const moveTo = async (point: { x: number; y: number }) => {
      await page.mouse.move(point.x, point.y, { steps: 10 })
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    await moveTo({ x: 20, y: 20 })
    assert.equal((await pointing()).open, 0, "nothing is open before the pointer reaches the strip")

    await moveTo(centres.restart)
    assert.deepEqual(await pointing(), { label: "Restart worker", open: 1 })

    // The reported gesture: onto the neighbour without leaving the strip.
    await moveTo(centres.collapse)
    assert.deepEqual(await pointing(), { label: "Collapse", open: 1 })

    // And back the other way, so the fix is not direction-dependent.
    await moveTo(centres.restart)
    assert.deepEqual(await pointing(), { label: "Restart worker", open: 1 })

    // Leaving the strip closes it rather than leaving a label stranded over the row.
    await moveTo({ x: 20, y: 20 })
    assert.equal((await pointing()).open, 0, "the tooltip closes when the pointer leaves the strip")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
