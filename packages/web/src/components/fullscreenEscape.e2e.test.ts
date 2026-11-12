import assert from "node:assert/strict"
import test from "node:test"

// Escape on /full exits fullscreen — after every layer above the page has had its turn (maintainer
// 2026-10-01: "hitting the escape key should always minimize a session that's in full screen view",
// then "respect the hierarchy": a file open in the viewer closes first).
// Real server, real transcript, real file reads; only the absent launcher status probe is stubbed.
// Boot scripts/adhoc-stack.mjs, then scripts/seed-file-panel-stack.mjs --home=<its HOME>.
// FRIZZ_FULL_ESCAPE_E2E_URL=http://127.0.0.1:<port> nub --test <this file>
const baseUrl = process.env.FRIZZ_FULL_ESCAPE_E2E_URL

// A QUEUED THREAD OPENS FROM THE HUMAN'S LAST MESSAGE, in the pane full screen as beside the sidebar (ChatView
// `queueWindow`), which is what a desktop's thread path draws since 2026-11-11: the seeded file links sit in
// the message before it, one click away.
async function revealEarlier(page: import("puppeteer").Page, link: string): Promise<void> {
  await page.waitForFunction((link) => !!document.querySelector(link) || !!document.querySelector("[data-standalone-thread] [data-load-earlier]"), { timeout: 30_000 }, link)
  if (!(await page.$(link))) await page.click("[data-standalone-thread] [data-load-earlier]")
  await page.waitForSelector(link)
}

test("Escape on /full unwinds the layers above the page, then exits fullscreen", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    await page.setViewport({ width: 1440, height: 900 })
    const full = `${baseUrl}/thread/file-panel-stack`
    const onFull = () => page.evaluate(() => /\/thread\/[^/]+$/.test(location.pathname))
    const leftFull = () => page.waitForFunction(() => !/\/thread\/[^/]+$/.test(location.pathname) && !document.querySelector("[data-standalone-thread]"))
    const open = async () => {
      await page.goto(full, { waitUntil: "networkidle2" })
      await revealEarlier(page, '[data-standalone-thread] [data-local-path$="/first.md"]')
    }
    // A settle window long enough for a navigation's view transition to have started, so an assertion
    // that the page STAYED is not just one that ran too early.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

    // 1. A file in the viewer is the top layer: the first Escape closes it, the second leaves.
    await open()
    await page.click('[data-standalone-thread] [data-local-path$="/first.md"]')
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 1)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 0)
    await settle()
    assert.equal(await onFull(), true, "closing the file viewer must not also exit fullscreen")
    await page.keyboard.press("Escape")
    await leftFull()

    // 2. A popup open on the page takes the press; the page stays. The snooze menu and the goal dialog
    // are Radix layers (they mark the key defaultPrevented); the permission picker claims it through
    // the shared Select registry instead — the ways a popup can own an Escape.
    // "Snooze" is the header's alarm clock (SnoozeMenu); "Goal" sits in the prompt box's rail.
    for (const trigger of ["Snooze", "Goal", "Thread permission mode"]) {
      await open()
      await page.waitForSelector(`[aria-label="${trigger}"]`, { visible: true })
      await page.click(`[aria-label="${trigger}"]`)
      // Off the trigger, so the Goal glyph's hover preview cannot open behind the panel's back.
      await page.mouse.move(700, 450)
      await page.waitForFunction((trigger) => document.querySelector(`[aria-label="${trigger}"]`)?.getAttribute("aria-expanded") === "true", {}, trigger)
      await page.keyboard.press("Escape")
      await page.waitForFunction((trigger) => document.querySelector(`[aria-label="${trigger}"]`)?.getAttribute("aria-expanded") !== "true", {}, trigger)
      await settle()
      assert.equal(await onFull(), true, `closing the ${trigger} must not also exit fullscreen`)
      await page.keyboard.press("Escape")
      await leftFull().catch((error) => { throw new Error(`Escape after closing the ${trigger} did not exit fullscreen`, { cause: error }) })
    }

    // 3. A focused composer does not cost an extra press: one Escape leaves, and the draft survives.
    await open()
    const composer = "[data-standalone-thread] textarea[data-claims-escape]"
    await page.click(composer)
    await page.keyboard.type("a draft that must survive")
    await page.keyboard.press("Escape")
    await leftFull()
    await open()
    assert.equal(await page.$eval(composer, (el) => (el as HTMLTextAreaElement).value), "a draft that must survive")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
