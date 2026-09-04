import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the invariant CardSlot states and nothing used to enforce: a dismissed queue card
// "fades out AT FULL HEIGHT ... There is no height-collapse phase". Skipped unless a Vite URL serving the
// fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and
// set FRIZZ_QUEUE_STEER_DISSOLVE_E2E_URL to its origin.
//
// THE BUG THIS PINS (maintainer 2026-09-04: "there's a lot of jitter, up-and-down jitter, before it
// settles"). Steering the agent dismisses the card AND appends the optimistic user bubble to the same
// transcript cache the card renders from — and the card's default window reaches back to the human's most
// recent turn, which that bubble now IS. Measured on a real steer before the fix: the card grew 58px at
// 27ms (the bubble), then dropped 276px at 77ms (everything above the bubble collapsed behind "Load
// earlier messages"), then unmounted at 342ms. Every card below it was shoved down, then up, then up
// again, inside one 200ms fade.
//
// The assertion is the reader's own invariant, not an internal one: from the keystroke to the unmount the
// card's layout box does not change and the card beneath it does not move.
const baseUrl = process.env.FRIZZ_QUEUE_STEER_DISSOLVE_E2E_URL

const STEERED = "csv-export"
const BELOW = "flaky-e2e"

test("steering a queue card dissolves it at a frozen height — the cards below it never move", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${STEERED}"]`)
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)

    const composer = `[data-queue-card="${STEERED}"] textarea[placeholder*="reply" i]`
    await page.waitForSelector(composer)
    await page.click(composer)
    // Long enough to WRAP, on purpose: the composer auto-grows with the text and collapses back the
    // instant the send clears it, which is the height change the exit pin exists for. A one-line steer
    // exercises only the transcript half of the fix.
    await page.type(composer, "Thanks — now do a second pass over the narrow viewport case: the CTA column collapses under 360px and the badge wraps onto a second line.")
    await new Promise((r) => setTimeout(r, 200))

    // Sample on every animation frame, in-page: a round trip per sample would miss the 50ms window the
    // two height changes lived in.
    await page.evaluate((steered: string, below: string) => {
      const w = window as unknown as { __steerFrames: { t: number; h: number | null; belowTop: number | null }[] }
      w.__steerFrames = []
      const t0 = performance.now()
      const tick = () => {
        const card = document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)
        const next = document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)
        w.__steerFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          // offsetHeight, not the painted rect: the leaving card wears scale(0.94), which shrinks what is
          // drawn without moving anything. The LAYOUT box is what shoves the cards beneath it.
          h: card ? card.offsetHeight : null,
          belowTop: next ? +next.getBoundingClientRect().top.toFixed(1) : null,
        })
        if (performance.now() - t0 < 900) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, STEERED, BELOW)

    const before = await page.evaluate((steered: string, below: string) => ({
      h: document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)!.offsetHeight,
      belowTop: +document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)!.getBoundingClientRect().top.toFixed(1),
    }), STEERED, BELOW)

    await page.keyboard.press("Enter")
    await new Promise((r) => setTimeout(r, 1100))
    const frames = await page.evaluate(() => (window as unknown as { __steerFrames: { t: number; h: number | null; belowTop: number | null }[] }).__steerFrames)

    const mounted = frames.filter((f) => f.h !== null)
    assert.ok(mounted.length > 4, `expected the card to stay mounted for several frames, got ${mounted.length}`)
    assert.ok(frames.some((f) => f.h === null), "the card must unmount within the sampled window")

    const heights = [...new Set(mounted.map((f) => f.h))]
    assert.deepEqual(heights, [before.h], `the card's height changed while it dissolved: ${JSON.stringify(mounted.filter((f) => f.h !== before.h).slice(0, 6))}`)

    // The card below is the reader's own witness: it must sit exactly where it was until the steered card
    // unmounts, at which point the deliberate one-shot landing moves it once.
    const untilUnmount = frames.slice(0, frames.findIndex((f) => f.h === null))
    const moved = untilUnmount.filter((f) => f.belowTop !== null && Math.abs(f.belowTop - before.belowTop) > 0.5)
    assert.deepEqual(moved, [], `a card below the dissolving one moved before the unmount: ${JSON.stringify(moved.slice(0, 6))}`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// THE SAME DEFECT THROUGH A SEND THAT DOES NOT DISMISS. The freeze above hangs on `leaving`, which only
// resolve() sets — but Retry and Restart worker, both on the queue card's OWN header, send through the
// same sendEagerFollowUp without resolving anything (so does the rail's hover Retry). A stalled or
// limit-killed thread is a hard queue member, which is precisely when those buttons show, so the card
// takes the optimistic bubble and then the worker's echo while sitting still in the queue — and with
// nothing dismissing it, the jitter has seconds to play instead of 200ms.
//
// Driven through sendEagerFollowUp itself rather than a button, so the assertion stays about the card and
// not about which header happens to carry the verb today.
test("a queue card holds still through a send that does not dismiss it — Retry, Restart worker, the rail", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-dissolve-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${STEERED}"]`)
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    await new Promise((r) => setTimeout(r, 300))

    // DOCUMENT geometry (offsetTop), not viewport geometry, on this path only: appendQueuedMessage
    // smooth-scrolls the window to the document bottom unless the caller opts out, and only the queue
    // card's own send does (TodosView passes scrollToBottom:false; every other surface commits to a
    // conversation tail and wants the bottom). That scroll moves the whole page for ~800ms, so a
    // getBoundingClientRect reading here measures the scroll and never the layout it is asked about.
    const before = await page.evaluate((steered: string, below: string) => ({
      h: document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)!.offsetHeight,
      belowTop: document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)!.offsetTop,
    }), STEERED, BELOW)

    await page.evaluate((steered: string, below: string) => {
      const w = window as unknown as {
        __steerFrames: { t: number; h: number | null; belowTop: number | null }[]
        __steerFromElsewhere: (slug: string, text: string) => void
        __pushLandedTurn: (slug: string, text: string) => void
      }
      w.__steerFrames = []
      const t0 = performance.now()
      const tick = () => {
        const card = document.querySelector<HTMLElement>(`[data-queue-card-root="${steered}"]`)
        const next = document.querySelector<HTMLElement>(`[data-queue-card-root="${below}"]`)
        w.__steerFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          h: card ? card.offsetHeight : null,
          belowTop: next ? next.offsetTop : null,
        })
        if (performance.now() - t0 < 900) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      // Both writes, in the order and at roughly the spacing they were measured at on a real worker: the
      // optimistic bubble on commit, the worker's echo of it ~150ms later.
      w.__steerFromElsewhere(steered, "Answering from the thread drawer instead of the card, which is the door the leaving gate never covered.")
      setTimeout(() => w.__pushLandedTurn(steered, "Answering from the thread drawer instead of the card, which is the door the leaving gate never covered."), 150)
    }, STEERED, BELOW)

    await new Promise((r) => setTimeout(r, 1100))
    const frames = await page.evaluate(() => (window as unknown as { __steerFrames: { t: number; h: number | null; belowTop: number | null }[] }).__steerFrames)

    // The board LAGS on this path by construction, so unlike the dismissal above the card must still be
    // there at the end — a card that vanished would make every height assertion below vacuous.
    assert.ok(frames.length > 20, `expected a full sampling window, got ${frames.length} frames`)
    assert.equal(frames.at(-1)?.h !== null, true, "the card must still be mounted: the board has not caught up yet")

    const heights = [...new Set(frames.map((f) => f.h))]
    assert.deepEqual(heights, [before.h], `the card changed height on a steer it did not send: ${JSON.stringify(frames.filter((f) => f.h !== before.h).slice(0, 6))}`)

    const moved = frames.filter((f) => f.belowTop !== null && Math.abs(f.belowTop - before.belowTop) > 0.5)
    assert.deepEqual(moved, [], `a card below the steered one was relaid out: ${JSON.stringify(moved.slice(0, 6))}`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
