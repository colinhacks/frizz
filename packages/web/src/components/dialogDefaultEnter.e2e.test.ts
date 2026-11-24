import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// ENTER ANSWERS A DIALOG WITH ITS WHITE BUTTON, in a real browser, on the real "End this session?"
// confirmation (ThreadLifecycle over ui/Dialog). Until 2026-11-24 Radix put the focus on the header's ×,
// so Enter closed the dialog instead of ending the session (maintainer: "When this or any other popover
// is showing on the screen and I press Enter, then the default button should be triggered, the white
// one. In all cases"). Which elements keep their own Enter is lib/dialogDefault.ts, held by its unit test.
//
// Skipped unless a Vite URL serving the fixtures is provided (scripts/e2e-web.mjs sets it): start `vite`
// in packages/web and set FRIZZ_DIALOG_DEFAULT_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_DIALOG_DEFAULT_E2E_URL

type Browser = Awaited<ReturnType<typeof import("puppeteer")["launch"]>>
type Page = import("puppeteer").Page

let browser: Browser | undefined
before(async () => {
  if (!baseUrl) return
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless()
})
after(async () => {
  await browser?.close()
})

/** The fixture's thread has a turn executing, so Mark as done asks first. */
async function openConfirm(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage()
  await page.setViewport({ width: 900, height: 700 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/completion-lifecycle-fixture.html?mode=executing`, { waitUntil: "networkidle0" })
  await page.click("button[aria-label='Mark as done']")
  await page.waitForSelector("[role=dialog] [data-dialog-default]")
  // Radix places the focus a frame after the dialog mounts.
  await page.waitForFunction(() => document.activeElement?.closest("[role=dialog]") != null)
  return { page, errors }
}

const calls = (page: Page) => page.$eval("[data-fixture-complete-calls]", (el) => el.textContent)
const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim())

test("the white button has the focus when the dialog opens, and Enter presses it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openConfirm()
  try {
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-dialog-default")), true, "not the header's ×")
    await page.keyboard.press("Enter")
    await page.waitForSelector("[data-fixture-done]")
    assert.equal(await calls(page), "RPC calls: initial, terminate")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("Enter still presses it after a click on the dialog's text has taken the focus off it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openConfirm()
  try {
    await page.click("[data-completion-hold] p")
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-dialog-default")), false, "the click moved the focus")
    await page.keyboard.press("Enter")
    await page.waitForSelector("[data-fixture-done]")
    assert.equal(await calls(page), "RPC calls: initial, terminate")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("another button the focus was moved to keeps its own Enter", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openConfirm()
  try {
    await page.keyboard.down("Shift")
    await page.keyboard.press("Tab")
    await page.keyboard.up("Shift")
    assert.equal(await focusedText(page), "Cancel")
    await page.keyboard.press("Enter")
    await page.waitForSelector("[role=dialog]", { hidden: true })
    assert.equal(await calls(page), "RPC calls: initial", "Cancel ended nothing")
    assert.equal(await page.$("[data-fixture-done]"), null)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
