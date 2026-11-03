import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Frizz whose launching project has at least
// one thread — the column under test only exists on a populated board — which two commands build:
//   nub scripts/adhoc-stack.mjs --port=45783 > /tmp/stack.log 2>&1 &
//   nub scripts/seed-done-thread.mjs --home=<home from the stack's json line> --port=45783
//   FRIZZ_FIRST_PAINT_E2E_URL=http://127.0.0.1:45783 nub --test --test-force-exit \
//     packages/web/src/App.firstPaint.e2e.test.ts
const baseUrl = process.env.FRIZZ_FIRST_PAINT_E2E_URL

// THE FIRST FRAME IS THE FINAL LAYOUT, on a reload in a browser that has seen this project before.
// Three things the page is built from arrive AFTER React's first render — the font and the project
// rail in `settingsGet`, and whether this project has a sidebar at all in the first board push — and
// each used to be guessed at first and corrected a round trip later, moving everything on screen:
// the type family flipped mono → sans (a document-wide reflow), the rail appeared and pushed the page
// 57px right, and the sidebar mounted and pushed the workpane 269px right (maintainer 2026-08-25:
// "This is layout shift"). The rail and the sidebar keep their last answer in localStorage and use it
// for the first frame; the font stopped being a setting on 2026-09-19 and is pinned sans on <html>. A requestAnimationFrame sampler installed before any script runs records every change to
// the three, so the assertion is over the whole load rather than a screenshot of one moment.
//
// The CONTROL clears the mirrors: the same sampler must then SEE the rail arrive late and the
// workpane move, or the assertions above were passing on a sampler that could not observe a shift.
type Sample = { t: number; font: string | undefined; rail: boolean; workpaneLeft: number | null }

test("a reload paints the font, the project rail and the sidebar column in their final state on the first frame", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const rpc = `${baseUrl}/_frizz/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const set = async (patch: Record<string, unknown>) => {
    const r = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, ...patch }) })
    assert.equal(r.status, 200, `settingsSet must succeed: ${await r.text()}`)
  }
  await set({ projectRail: true })

  const { launchHeadless } = await import("../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      const t0 = performance.now()
      const log: Sample[] = ((window as unknown as { __samples: Sample[] }).__samples = [])
      let last = ""
      const tick = () => {
        const wp = document.getElementById("workpane")?.getBoundingClientRect()
        const s: Sample = {
          t: Math.round(performance.now() - t0),
          font: document.documentElement.dataset.font,
          rail: document.querySelector('nav[aria-label="Projects"]') !== null,
          workpaneLeft: wp ? Math.round(wp.left) : null,
        }
        const key = JSON.stringify([s.font, s.rail, s.workpaneLeft])
        if (key !== last) { last = key; log.push(s) }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const samples = () => page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples)
    const load = async () => {
      await page.goto(`${baseUrl}/project/frizz`, { waitUntil: "networkidle2" })
      await page.waitForSelector("aside:not([data-sidebar-reserved]) [data-status-row]", { timeout: 20_000 })
      await new Promise((r) => setTimeout(r, 500))
      return samples()
    }

    // The first load in a fresh profile is allowed to shift: it is what writes the mirrors.
    const first = await load()
    assert.ok(first.some((s) => s.workpaneLeft !== null), "the board rendered a workpane")
    const settledLeft = first.at(-1)!.workpaneLeft

    // The reload is the case: every sample is the final answer.
    const warm = await load()
    const painted = warm.filter((s) => s.workpaneLeft !== null)
    assert.ok(painted.length > 0, "the reload rendered a workpane")
    // `data-font` is pinned on the <html> tag since 2026-09-19 (the mono setting is gone), so it is
    // sans on every frame by construction; sampled anyway so a regression that reintroduces a
    // late-applied font shows up here.
    assert.deepEqual(new Set(warm.map((s) => s.font)), new Set(["sans"]), `the font never left sans: ${JSON.stringify(warm)}`)
    assert.deepEqual(new Set(painted.map((s) => s.workpaneLeft)), new Set([settledLeft]), `the workpane never moved: ${JSON.stringify(warm)}`)
    assert.equal(painted[0]!.rail, true, `the rail is on the first painted frame: ${JSON.stringify(warm)}`)

    // Old Mono settings and cache must not change the font. Clearing the rail/board mirrors
    // remains the negative control: the sampler must see the rail arrive and the workpane move.
    await set({ font: "mono", projectRail: true })
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem("frizz-font", "mono") })
    const control = await load()
    const controlPainted = control.filter((s) => s.workpaneLeft !== null)
    assert.deepEqual(new Set(control.map((s) => s.font)), new Set(["sans"]), `obsolete Mono settings cannot change the font: ${JSON.stringify(control)}`)
    assert.ok(new Set(controlPainted.map((s) => s.workpaneLeft)).size > 1, `the control saw the workpane move: ${JSON.stringify(control)}`)
    assert.equal(controlPainted[0]!.rail, false, `the control saw the rail arrive late: ${JSON.stringify(control)}`)

    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
    await set({})
  }
})

// THE LOADER IS CENTRED ON THE PAGE, not on the workpane. The reserved sidebar column above puts the
// workpane where the board will put it, and the loader used to sit inside the workpane: 269px right of
// centre at 1440px on every reload of a project with a sidebar (2026-11-02, "spinner isn't centered while
// loading a project page"). The board is withheld here — its HTTP read never answered and no socket
// opened — so the loader stays up long enough to measure; the reserved column being present is the
// condition that broke it, so the test asserts it first.
test("while the board loads, the spinner is centred on the page beside the reserved sidebar column", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    for (const [width, height] of [[1440, 900], [1000, 800], [760, 900]] as const) {
      const page = await browser.newPage()
      await page.setViewport({ width, height, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/project/frizz`, { waitUntil: "networkidle2" })
      await page.waitForSelector("aside:not([data-sidebar-reserved]) [data-status-row]", { timeout: 20_000 })
      await page.setRequestInterception(true)
      page.on("request", (request) => { if (!/\/rpc\/board/.test(request.url())) void request.continue() })
      await page.evaluateOnNewDocument(() => {
        class Closed extends EventTarget { readyState = 0; send() {} close() {} }
        Object.assign(window, { WebSocket: Closed, EventSource: Closed })
      })
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.waitForSelector('[role="status"][aria-label="Loading project"] .animate-spin', { timeout: 20_000 })
      const at = await page.evaluate(() => {
        const spinner = document.querySelector('[aria-label="Loading project"] .animate-spin')!.getBoundingClientRect()
        const rail = document.querySelector('nav[aria-label="Projects"]')?.getBoundingClientRect()
        const left = rail && rail.width > 0 ? rail.right : 0
        return {
          reserved: document.querySelector("[data-sidebar-reserved]") !== null,
          dx: spinner.left + spinner.width / 2 - (left + (innerWidth - left) / 2),
          dy: spinner.top + spinner.height / 2 - innerHeight / 2,
        }
      })
      assert.equal(at.reserved, true, `${width}px: the reload reserved the sidebar column`)
      assert.ok(Math.abs(at.dx) <= 0.5 && Math.abs(at.dy) <= 0.5, `${width}px: the spinner is centred on the page: ${JSON.stringify(at)}`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
