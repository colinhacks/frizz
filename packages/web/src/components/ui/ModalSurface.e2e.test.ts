import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// WHERE THE FOCUS GOES WHEN A FULL-SCREEN SURFACE CLOSES, in a real browser, on the real ui/ModalSurface
// (the rule and its cases are in lib/restoreFocus.ts, which a unit test holds; this holds the wiring:
// that the opener is read before Radix moves the focus, and handed back after the surface has gone).
// Until 2026-11-10 closing Settings or ⌘K left the focus on <body>, so the next Tab started from the
// first link on the page.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_MODAL_SURFACE_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_MODAL_SURFACE_E2E_URL

type Browser = Awaited<ReturnType<typeof import("puppeteer")["launch"]>>
type Page = import("puppeteer").Page

let browser: Browser | undefined
before(async () => {
  if (!baseUrl) return
  const { launchHeadless } = await import("../../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless()
})
after(async () => {
  await browser?.close()
})

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage()
  await page.setViewport({ width: 900, height: 700 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/modal-surface-fixture.html`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-open-a]")
  return { page, errors }
}

/** The focused element, as the one data attribute that names it in the fixture (or its tag). */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return "body"
    return [...el.attributes].find((a) => a.name.startsWith("data-") && a.name !== "data-autofocus" && a.name !== "data-state")?.name ?? el.tagName.toLowerCase()
  })
/** Waits for the surface to have gone AND for Radix's close step, which runs a task later. */
async function closed(page: Page, surface: string) {
  await page.waitForSelector(surface, { hidden: true })
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 60)))
}
async function openA(page: Page) {
  await page.focus("[data-open-a]")
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-a-input"))
}

test("closing a surface returns the focus to what opened it, so Tab carries on from there", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await openA(page)
    await page.keyboard.press("Escape")
    await closed(page, "[data-surface-a]")
    assert.equal(await focused(page), "data-open-a", "Escape hands the focus back to the button")
    assert.equal(await page.$eval("[data-open-a]", (el) => el.matches(":focus-visible")), true, "and a keyboard user sees where it is")
    await page.keyboard.press("Tab")
    assert.equal(await focused(page), "data-other", "the next Tab is the next control, not the top of the page")

    // A close button inside the surface, clicked.
    await openA(page)
    await page.click("[data-close-a]")
    await closed(page, "[data-surface-a]")
    assert.equal(await focused(page), "data-open-a")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("a surface opened from another returns the focus through it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    // B OVER A: A is still there when B closes, so the button in A that opened B gets the focus back.
    await openA(page)
    await page.click("[data-b-over-a]")
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-b-input"))
    await page.keyboard.press("Escape")
    await closed(page, "[data-surface-b]")
    assert.equal(await focused(page), "data-b-over-a")
    await page.keyboard.press("Escape")
    await closed(page, "[data-surface-a]")
    assert.equal(await focused(page), "data-open-a")

    // B IN A'S PLACE (⌘K's "Settings"): what opened B left with A, so B returns to what opened A.
    await openA(page)
    await page.click("[data-b-instead]")
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-b-input"))
    assert.equal(await page.$("[data-surface-a]"), null)
    await page.keyboard.press("Escape")
    await closed(page, "[data-surface-b]")
    assert.equal(await focused(page), "data-open-a")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("a close that moved the focus elsewhere, or whose opener has gone, takes nothing back", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await openA(page)
    await page.click("[data-close-and-go]")
    await closed(page, "[data-surface-a]")
    assert.equal(await focused(page), "data-other", "what took the focus as the surface closed keeps it")

    // A close the surface says was not a dismissal: ⌘K after it has run a command.
    await openA(page)
    await page.click("[data-run-command]")
    await closed(page, "[data-surface-a]")
    assert.equal(await focused(page), "body", "the command decides the focus, and this one left it on the page")
    // The next opening is a fresh one: dismissed, it hands the focus back again.
    await openA(page)
    await page.keyboard.press("Escape")
    await closed(page, "[data-surface-a]")
    assert.equal(await focused(page), "data-open-a")

    await openA(page)
    await page.click("[data-close-without-opener]")
    await closed(page, "[data-surface-a]")
    assert.equal(await page.$("[data-open-a]"), null)
    assert.equal(await focused(page), "body")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("a pointer that opened and closed a surface is shown no focus ring", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await open()
  try {
    await page.click("[data-open-a]")
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-a-input"))
    await page.click("[data-close-a]")
    await closed(page, "[data-surface-a]")
    assert.equal(await focused(page), "data-open-a")
    assert.equal(await page.$eval("[data-open-a]", (el) => el.matches(":focus-visible")), false)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
