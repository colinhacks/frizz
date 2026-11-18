import assert from "node:assert/strict"
import test from "node:test"

// THE THREAD WIDTH SETTING (lib/fullLayout.ts THREAD_WIDTH_PX) on the real PaneLayout and Sidebar in
// pane-width-fixture.html. The setting is a cap and nothing else: as the window grows the sidebar takes the
// slack first, up to 480, then the thread grows to the cap, and the rest goes to the far left and right. So
// Standard must draw exactly what the pane drew before the setting, no choice may move the 1360 line where
// the rail stands beside the sidebar, and no choice may overflow the window. Which column gives way is the
// browser's flex and clamp() arithmetic, so only a browser can say.
//
//   cd packages/web && nubx vite --port 5951 --strictPort
//   FRIZZ_PANE_THREAD_WIDTH_E2E_URL=http://localhost:5951 nub run test packages/web/src/components/paneThreadWidth.e2e.test.ts
const baseUrl = process.env.FRIZZ_PANE_THREAD_WIDTH_E2E_URL

type Page = import("puppeteer").Page
type Setting = "standard" | "wide" | "widest"
const SETTINGS: Setting[] = ["standard", "wide", "widest"]

async function open(page: Page, width: number, query: string) {
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 })
  await page.goto(`${baseUrl}/pane-width-fixture.html?${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-pane-thread] [data-drawer-transcript-scroll]")
}

// [left, width] of each column, to a tenth of a pixel; null for one that is not on screen.
const columns = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => {
    const r = document.querySelector(selector)?.getBoundingClientRect()
    return r && r.width > 0 ? [Math.round(r.left * 10) / 10, Math.round(r.width * 10) / 10] : null
  }
  return {
    layout: document.querySelector("[data-pane-layout]")?.getAttribute("data-pane-layout"),
    sidebar: box("[data-pane-sidebar]"),
    thread: box("[data-pane-thread]"),
    side: box("[data-side-pane]"),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }
})

async function withPage(run: (page: Page) => Promise<void>) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await run(page)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
}

test("beside the sidebar, the sidebar takes the slack first, then the thread grows to the setting, then the edges", { skip: !baseUrl, timeout: 300_000 }, async () => {
  // Thread width at each window and setting. Standard is the pane before the setting existed (read off
  // main at 5161ec761): 720 wherever it fits, 62vw narrow.
  const thread: Record<number, Record<Setting, number>> = {
    2400: { standard: 720, wide: 840, widest: 960 },
    1660: { standard: 720, wide: 840, widest: 840 },
    1360: { standard: 720, wide: 720, widest: 720 },
    1300: { standard: 720, wide: 820, widest: 820 },
    1100: { standard: 682, wide: 682, widest: 682 },
    820: { standard: 508.4, wide: 508.4, widest: 508.4 },
  }
  const sidebar: Record<number, number> = { 2400: 480, 1660: 480, 1360: 300, 1300: 480, 1100: 418, 820: 311.6 }
  await withPage(async (page) => {
    for (const setting of SETTINGS) {
      for (const [w, want] of Object.entries(thread)) {
        const width = Number(w)
        await open(page, width, `width=${setting}`)
        const got = await columns(page)
        const at = `${setting} at ${width}px`
        const rail = width >= 1360
        assert.equal(got.layout, rail ? "wide" : "narrow", at)
        assert.equal(got.sidebar?.[1], sidebar[width], `${at}: the sidebar`)
        assert.equal(got.thread?.[1], want[setting], `${at}: the thread`)
        assert.deepEqual(got.side, rail ? [got.thread![0] + got.thread![1], 340] : null, `${at}: the rail, against the thread`)
        assert.equal(got.thread![0], got.sidebar![0] + got.sidebar![1], `${at}: the thread, against the sidebar`)
        // What none of the columns takes is shared equally by the far left and the far right.
        const right = width - (rail ? got.side![0] + got.side![1] : got.thread![0] + got.thread![1])
        assert.ok(Math.abs(got.sidebar![0] - right) < 0.6, `${at}: the group is centred (${got.sidebar![0]} left, ${right} right)`)
        assert.equal(got.overflow, 0, `${at}: nothing overflows`)
      }
    }
  })
})

test("no setting moves the line where the rail stands beside the sidebar", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await withPage(async (page) => {
    for (const setting of SETTINGS) {
      await open(page, 1359, `width=${setting}`)
      assert.equal((await columns(page)).layout, "narrow", `${setting} at 1359px`)
      await open(page, 1360, `width=${setting}`)
      const got = await columns(page)
      assert.deepEqual([got.layout, got.sidebar, got.thread, got.side], ["wide", [0, 300], [300, 720], [1020, 340]], `${setting} at 1360px`)
    }
  })
})

test("full screen caps the thread at the setting, and beside the rail keeps the half-page rule below twice the cap", { skip: !baseUrl, timeout: 300_000 }, async () => {
  // Beside the rail (1200 and up) the thread is half the page until that reaches the cap, so a file opening
  // over the rail can take the other half without the thread re-wrapping (lib/fullLayout.ts layoutVars).
  // Below 1200 it is one column, at the cap or the page.
  const thread: Record<number, Record<Setting, number>> = {
    2400: { standard: 720, wide: 840, widest: 960 },
    1660: { standard: 720, wide: 830, widest: 830 },
    1360: { standard: 680, wide: 680, widest: 680 },
    1100: { standard: 720, wide: 840, widest: 960 },
    820: { standard: 720, wide: 820, widest: 820 },
  }
  await withPage(async (page) => {
    for (const setting of SETTINGS) {
      for (const [w, want] of Object.entries(thread)) {
        const width = Number(w)
        await open(page, width, `width=${setting}&folded=1`)
        const got = await columns(page)
        const at = `${setting} full screen at ${width}px`
        assert.equal(got.sidebar, null, at)
        assert.equal(got.thread?.[1], want[setting], `${at}: the thread`)
        if (width >= 1200) {
          // The thread and the rail's 340 centred as a pair: the gutter left of the thread is the slack.
          assert.equal(got.thread![0], (width - want[setting] - 340) / 2, `${at}: the pair is centred`)
          assert.equal(got.side![0], got.thread![0] + got.thread![1], `${at}: the rail, against the thread`)
        } else {
          assert.equal(got.thread![0], (width - want[setting]) / 2, `${at}: the column is centred`)
        }
        assert.equal(got.overflow, 0, `${at}: nothing overflows`)
      }
    }
  })
})

test("a file beside the thread gets the thread's width before the sidebar grows", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const want: Record<Setting, { sidebar: number; thread: number; file: number }> = {
    standard: { sidebar: 480, thread: 720, file: 1200 },
    wide: { sidebar: 480, thread: 840, file: 1080 },
    widest: { sidebar: 480, thread: 960, file: 960 },
  }
  await withPage(async (page) => {
    for (const setting of SETTINGS) {
      await open(page, 2400, `width=${setting}&file=1`)
      await page.waitForSelector("[data-side-pane] [data-file-viewer-panel]")
      const got = await columns(page)
      const at = `${setting} with a file at 2400px`
      assert.deepEqual(
        { sidebar: got.sidebar, thread: got.thread, file: got.side },
        { sidebar: [0, want[setting].sidebar], thread: [480, want[setting].thread], file: [480 + want[setting].thread, want[setting].file] },
        at,
      )
      assert.equal(got.overflow, 0, at)
    }
  })
})
