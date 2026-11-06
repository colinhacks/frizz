import assert from "node:assert/strict"
import test from "node:test"

// The permission selector in the new-thread prompt box: the same per-project value as the gear's
// Permissions, so each has to show what the other wrote. That takes a real browser, because the gear's
// draft and the selector's cached copy are different objects, and a whole-object write from a stale one
// would quietly undo the other's pick.
//
// Drives dispatch-composer-profile-fixture, which records every settingsSet. Skipped unless
// FRIZZ_PROMPT_BOX_PERMISSION_E2E_URL names a vite serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.FRIZZ_PROMPT_BOX_PERMISSION_E2E_URL

type Fixture = { settingsWrites: Record<string, unknown>[] }
const SELECTOR = 'button[aria-label="New thread permission mode"]'
const PROFILE = 'button[aria-label="Model and effort"]'
const GEAR = 'button[aria-label="Claude Code settings"]'
const GEAR_PERMISSION = 'button[aria-label="Claude permission mode"]'
const PANEL = '[data-agent-settings-menu="claude"]'
const MENU_ROW = '[role="menu"]:not(.profile-grid-menu) [role="menuitemradio"]'

async function open(query: string, viewport = { width: 1100, height: 900 }) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/dispatch-composer-profile-fixture.html${query}`, { waitUntil: "networkidle0" })
  return { browser, page, errors }
}

type Page = import("puppeteer").Page
const writes = (page: Page) => page.evaluate(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.map((w) => ({ ...w })))
const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim())

async function pick(page: Page, trigger: string, label: string) {
  await page.click(trigger)
  await page.waitForSelector(MENU_ROW)
  const rows = await page.$$(MENU_ROW)
  for (const row of rows) {
    if ((await row.evaluate((el) => el.textContent?.trim())) === label) return row.click()
  }
  throw new Error(`no row named ${label}`)
}
const shows = (page: Page, selector: string, label: string) =>
  page.waitForFunction((s, l) => document.querySelector(s)?.textContent?.trim() === l, { timeout: 5_000 }, selector, label)

test("a pick is one whole-object write, and shows at once", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page, errors } = await open("?backend=claude&settingsDelay=600")
  try {
    await page.waitForSelector(SELECTOR)
    assert.equal(await text(page, SELECTOR), "Bypass", "the project's stored mode")
    await pick(page, SELECTOR, "Auto")
    await shows(page, SELECTOR, "Auto")
    assert.deepEqual(await writes(page), [], "the selector moved before the slow write landed")
    await page.waitForFunction(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.length > 0)
    const [sent, ...rest] = await writes(page)
    assert.equal(sent!.permissionMode, "auto")
    assert.equal(sent!.autoCompactWindow, 500000, "the rest of the object rides along")
    assert.deepEqual(rest, [])
    await pick(page, SELECTOR, "Auto")
    assert.equal((await writes(page)).length, 1, "picking the value already set writes nothing")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the selector and the gear show each other's picks, and neither undoes the other", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page, errors } = await open("?backend=claude")
  try {
    await page.waitForSelector(SELECTOR)
    await pick(page, SELECTOR, "Auto")
    await shows(page, SELECTOR, "Auto")
    await page.click(PROFILE)
    await page.waitForSelector(GEAR)
    await page.click(GEAR)
    await page.waitForSelector(PANEL)
    assert.equal(await text(page, GEAR_PERMISSION), "Auto", "the gear opens on the selector's pick")
    await pick(page, GEAR_PERMISSION, "Bypass")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await shows(page, SELECTOR, "Bypass")
    await pick(page, SELECTOR, "Auto")
    await page.waitForFunction(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.length >= 3)
    assert.deepEqual((await writes(page)).map((w) => w.permissionMode), ["auto", "bypassPermissions", "auto"])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the selector's label and chevron sit where the model pill's do", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page } = await open("?backend=claude")
  try {
    await page.waitForSelector(SELECTOR)
    const read = (selector: string) => page.$eval(selector, (button) => {
      const range = document.createRange()
      range.selectNodeContents(button.querySelector("span")!)
      const label = range.getBoundingClientRect()
      const caret = button.querySelector("svg")!.getBoundingClientRect()
      const box = button.getBoundingClientRect()
      return { labelBottom: label.bottom - box.top, toCaret: caret.left - label.right, height: box.height }
    })
    const [pill, selector] = [await read(PROFILE), await read(SELECTOR)]
    assert.equal(selector.height, pill.height)
    assert.equal(selector.labelBottom, pill.labelBottom, "one baseline across the strip")
    assert.ok(Math.abs(selector.toCaret - pill.toCaret) < 0.5, `chevron gap ${selector.toCaret} beside ${pill.toCaret}`)
  } finally {
    await browser.close()
  }
})

test("a Codex model has no selector, and neither does a phone", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const codex = await open("")
  try {
    await codex.page.waitForSelector(PROFILE)
    assert.equal(await codex.page.$(SELECTOR), null)
  } finally {
    await codex.browser.close()
  }
  const phone = await open("?backend=claude", { width: 390, height: 844 })
  try {
    await phone.page.waitForSelector("textarea")
    assert.equal(await phone.page.$(SELECTOR), null)
  } finally {
    await phone.browser.close()
  }
})
