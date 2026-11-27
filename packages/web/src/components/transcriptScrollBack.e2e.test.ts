import assert from "node:assert/strict"
import test from "node:test"

// SCROLLING BACK THROUGH A LONG THREAD NEVER MOVES IT AGAINST THE READER. Wheeling up reaches "Load earlier
// messages" again and again, and each page lands while the reader is still moving. The restore that keeps
// their row in place across the prepend held it for ten frames after the landing, and each of those frames
// put back the notch they had just wheeled: the transcript stuttered 20px down and up at every page
// boundary. And it restored the place the load was ASKED from, so everything wheeled while the page was in
// flight came back in one jump at the landing: 462-478px here with a 300ms fetch, 464-470px on a real
// thread with a 400ms one (2026-11-28).
//
// A trackpad's stream of small notches, 20px every 8ms, is replayed over transcript-scroll-back-fixture.html
// across two earlier pages, once with pages that arrive at once and once with pages that take 300ms, and
// the row under the reader is read on every frame. With the wheel going up, content only ever moves DOWN
// the screen, with one allowance: the frame a page lands on may lose the one notch the compositor applied
// since the last frame, which no main-thread scroll write can carry (the virtualizer's own corrections
// lose it the same way). More than one such frame per landing, or a larger move, is the stutter.
//
// Skipped unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// FRIZZ_TRANSCRIPT_SCROLL_BACK_E2E_URL to its origin (or let `nub run test:e2e` do both).
const baseUrl = process.env.FRIZZ_TRANSCRIPT_SCROLL_BACK_E2E_URL

const NOTCH = 20
const EVERY_MS = 8
const PAGES = 2

interface Frame { key: string | null; y: number | null; repicked: boolean }

for (const earlierDelay of [0, 300]) {
  test(`wheeling up across earlier pages that take ${earlierDelay}ms never moves the transcript against the reader`, { skip: !baseUrl, timeout: 120_000 }, async () => {
    const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
    const browser = await launchHeadless()
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      const errors: string[] = []
      page.on("pageerror", (e) => errors.push(String(e)))
      page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
      await page.goto(`${baseUrl}/transcript-scroll-back-fixture.html?earlierDelay=${earlierDelay}`, { waitUntil: "networkidle0" })
      await page.waitForSelector("[data-drawer-transcript-scroll] [data-transcript-row-key]")
      await new Promise((r) => setTimeout(r, 1000))

      // One reading per frame: the first row a little way into the pane, followed until it leaves.
      const center = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>("[data-drawer-transcript-scroll]")!
        const state = window as unknown as { __frames: Frame[]; __stop: boolean }
        state.__frames = []
        state.__stop = false
        let key: string | null = null
        const rows = () => Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
        const loop = () => {
          const top = scroller.getBoundingClientRect().top
          let row = key ? rows().find((el) => el.dataset.transcriptRowKey === key) : undefined
          let repicked = false
          if (!row || row.getBoundingClientRect().top > top + scroller.clientHeight - 40) {
            row = rows().find((el) => el.getBoundingClientRect().top > top + 40)
            key = row?.dataset.transcriptRowKey ?? null
            repicked = true
          }
          state.__frames.push({ key, y: row ? row.getBoundingClientRect().top : null, repicked })
          if (!state.__stop) requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
        const box = scroller.getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      })
      await page.mouse.move(center.x, center.y)
      const cdp = await page.createCDPSession()
      const served = () => page.evaluate(() => (window as unknown as { __scrollBack: { earlierPagesServed(): number } }).__scrollBack.earlierPagesServed())
      const started = Date.now()
      let sent = 0
      const notch = async () => {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY: -NOTCH })
        sent++
        const wait = started + sent * EVERY_MS - Date.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      }
      while (sent < 2500 && (await served()) < PAGES) for (let i = 0; i < 10; i++) await notch()
      // …and on through the frames that settle the last landing.
      for (let i = 0; i < 60; i++) await notch()
      await new Promise((r) => setTimeout(r, 300))
      const frames = await page.evaluate(() => {
        const state = window as unknown as { __frames: Frame[]; __stop: boolean }
        state.__stop = true
        return state.__frames
      })
      assert.ok((await served()) >= PAGES, `the reader wheeled across ${PAGES} earlier pages (${await served()} served)`)

      const against: { frame: number; moved: number }[] = []
      for (let i = 1; i < frames.length; i++) {
        const [a, b] = [frames[i - 1], frames[i]]
        if (b.repicked || a.key !== b.key || a.y === null || b.y === null) continue
        if (b.y - a.y < -1) against.push({ frame: i, moved: Math.round(b.y - a.y) })
      }
      const detail = `${JSON.stringify(against)} over ${frames.length} frames`
      assert.ok(against.length <= PAGES, `at most one frame per landing moves against the wheel: ${detail}`)
      assert.ok(against.every(({ moved }) => moved >= -(NOTCH + 2)), `no frame moves against the wheel by more than the notch it lost: ${detail}`)
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
}
