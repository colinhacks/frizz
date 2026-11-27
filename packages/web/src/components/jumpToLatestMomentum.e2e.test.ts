import assert from "node:assert/strict"
import test from "node:test"
import type { CDPSession, Page } from "puppeteer"

// "JUMP TO LATEST" STOPS THE SCROLL IT INTERRUPTED. Pressed while a flick was still carrying the reader up,
// it put them on the tail and the momentum carried on from there, straight back up: the momentum is the
// browser's, and a programmatic scroll does not end it (reported 2026-11-28: "if we press the jump to
// bottom button while scrolling up, it keeps the momentum so we go to bottom but keep going up").
//
// Two kinds of momentum, both over transcript-scroll-back-fixture.html, a running thread on its tail:
//   · a touch fling, which the compositor runs by itself after the finger lifts — a real one, synthesized;
//   · a trackpad's, which reaches the page as a stream of wheel events that shrink until they stop. A
//     headless browser has no trackpad, so the stream is replayed: the shape is the point, and a held
//     scroller must drop it, then scroll again for the reader's next gesture.
//
// Skipped unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// FRIZZ_JUMP_TO_LATEST_MOMENTUM_E2E_URL to its origin (or let `nub run test:e2e` do both).
const baseUrl = process.env.FRIZZ_JUMP_TO_LATEST_MOMENTUM_E2E_URL

const SCROLLER = "[data-drawer-transcript-scroll]"

interface Reading { distance: number; scrollTop: number; width: number; overflowY: string; jumpVisible: boolean }
const read = (page: Page) => page.evaluate((sel) => {
  const scroller = document.querySelector<HTMLElement>(sel)!
  return {
    distance: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
    scrollTop: Math.round(scroller.scrollTop),
    width: scroller.clientWidth,
    overflowY: getComputedStyle(scroller).overflowY,
    jumpVisible: document.querySelector("[data-jump-to-latest]") !== null,
  }
}, SCROLLER) as Promise<Reading>

async function open(page: Page): Promise<{ cdp: CDPSession; x: number; y: number }> {
  await page.goto(`${baseUrl}/transcript-scroll-back-fixture.html`, { waitUntil: "networkidle0" })
  await page.waitForSelector(`${SCROLLER} [data-transcript-row-key]`)
  await new Promise((r) => setTimeout(r, 1000))
  const box = await page.evaluate((sel) => {
    const rect = document.querySelector<HTMLElement>(sel)!.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, SCROLLER)
  const cdp = await page.createCDPSession()
  // Off the tail by the reader's own hand, so "Jump to latest" is drawn.
  await page.mouse.move(box.x, box.y)
  for (let i = 0; i < 10; i++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -80 })
    await new Promise((r) => setTimeout(r, 16))
  }
  await page.waitForSelector("[data-jump-to-latest]", { timeout: 5000 })
  return { cdp, ...box }
}

async function pressJump(page: Page): Promise<number> {
  const button = await page.$("[data-jump-to-latest]")
  const box = (await button!.boundingBox())!
  const width = (await read(page)).width
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  return width
}

test("Jump to latest pressed during a touch fling stays on the tail", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, hasTouch: true })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    const { cdp, x, y } = await open(page)
    const before = await read(page)
    // A flick up, left to fling: the gesture moves 1,500px and the fling carries it on after the finger lifts.
    const fling = cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: 1500, speed: 6000, gestureSourceType: "touch", preventFling: false })
    await page.waitForFunction((sel, top) => document.querySelector<HTMLElement>(sel)!.scrollTop < top - 1700, { timeout: 10_000, polling: "raf" }, SCROLLER, before.scrollTop)
    const width = await pressJump(page)
    const held = await read(page)
    await fling
    await new Promise((r) => setTimeout(r, 2000))
    const after = await read(page)
    assert.equal(held.width, width, "holding the scroller still reflows nothing: its gutter stays reserved")
    assert.ok(after.distance <= 2, `the fling did not carry the reader back off the tail: ${JSON.stringify(after)}`)
    assert.equal(after.jumpVisible, false)
    assert.equal(after.overflowY, "auto", "the scroller scrolls again once the fling is spent")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("Jump to latest pressed during a trackpad's momentum drops the rest of it, then scrolls again", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    const { cdp, x, y } = await open(page)
    const wheel = (deltaY: number) => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY })
    await pressJump(page)
    // The momentum that follows the press: a wheel event a frame, shrinking from 60px to nothing.
    await page.mouse.move(x, y)
    let delta = 60
    while (delta >= 1) {
      await wheel(-Math.round(delta))
      await new Promise((r) => setTimeout(r, 16))
      delta *= 0.92
    }
    await new Promise((r) => setTimeout(r, 300))
    const after = await read(page)
    assert.ok(after.distance <= 2, `the momentum did not carry the reader back off the tail: ${JSON.stringify(after)}`)
    assert.equal(after.overflowY, "auto", "the hold ends once the momentum stops")
    // …and the reader's next gesture is theirs again.
    for (let i = 0; i < 10; i++) {
      await wheel(-40)
      await new Promise((r) => setTimeout(r, 16))
    }
    await new Promise((r) => setTimeout(r, 300))
    const next = await read(page)
    assert.ok(next.distance >= 300, `a new gesture after the hold scrolls the transcript: ${JSON.stringify(next)}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
