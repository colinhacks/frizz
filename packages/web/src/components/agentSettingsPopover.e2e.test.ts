import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the model picker's AGENT SETTINGS panel — the gear on a runtime's band that
// replaced the context dropdown on 2026-09-19. The dropdown it replaced died the moment the pointer
// left its trigger (a non-modal popover inside a Radix menu item: the menu focuses its own content on
// item-leave, which the popover read as focus-outside). Nothing but a real browser can prove the
// replacement cannot: a source test can pin the `modal` flag, not what Radix does with it.
//
// Drives dispatch-composer-profile-fixture, which records every settingsSet the panel makes. Skipped
// unless FRIZZ_AGENT_SETTINGS_E2E_URL names a vite serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.FRIZZ_AGENT_SETTINGS_E2E_URL

type Fixture = { settingsWrites: Record<string, unknown>[] }
const MENU = ".profile-grid-menu"
const PANEL = '[data-agent-settings-menu="claude"]'
const GEAR = 'button[aria-label="Claude Code settings"]'
const PERMISSION = 'button[aria-label="Claude permission mode"]'
// The Select's own rows. The picker's grid cells are menuitemradios too, so the rows are scoped to
// the one menu that is NOT the profile grid — the Select portals its menu at z-[260], above the panel.
const SELECT_MENU = '[role="menu"]:not(.profile-grid-menu)'
const SELECT_ROW = `${SELECT_MENU} [role="menuitemradio"]`

async function launch(query = "") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/dispatch-composer-profile-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector('button[aria-label="Model and effort"]')
  return { browser, page, errors }
}

const writes = (page: import("puppeteer").Page) =>
  page.evaluate(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.map((w) => ({ ...w })))

async function openPanel(page: import("puppeteer").Page) {
  await page.click('button[aria-label="Model and effort"]')
  await page.waitForSelector(MENU)
  await page.click(GEAR)
  await page.waitForSelector(PANEL)
}

const center = async (page: import("puppeteer").Page, selector: string) => {
  const box = (await (await page.$(selector))!.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test("the panel survives the pointer leaving it, and a pick writes the whole settings object once", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await openPanel(page)
    // The failure this guards: leave the gear, cross the menu's own items, park far away. The old
    // control was gone before the pointer reached its panel.
    const gear = await center(page, GEAR)
    await page.mouse.move(gear.x, gear.y)
    for (const item of await page.$$(`${MENU} [role="menuitemradio"]`)) {
      const box = await item.boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 })
    }
    await page.mouse.move(8, 8, { steps: 10 })
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(await page.$(PANEL), "the panel is still open after the pointer wandered off it")
    assert.ok(await page.$(MENU), "and the picker under it is still open too")
    // While the panel is open the picker beneath it is inert: its rows cannot be hit.
    const row = await center(page, `${MENU} [role="menuitemradio"]`)
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=menuitemradio]") !== null, row)
    assert.equal(hit, false, "a picker row is not hittable through the modal panel")

    // A Select inside the panel portals ABOVE it — its rows take the click, not the panel.
    await page.click(PERMISSION)
    await page.waitForSelector(`${SELECT_ROW}[aria-checked="false"]`)
    assert.ok(Number(await page.$eval(SELECT_MENU, (el) => getComputedStyle(el).zIndex)) > 250, "the Select's menu stacks above the z-[250] panel")
    const option = await center(page, `${SELECT_ROW}[aria-checked="false"]`)
    const optionHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=menuitemradio]")?.getAttribute("aria-checked"), option)
    assert.equal(optionHit, "false", "the Select's own row receives the pointer above the panel")
    await page.mouse.click(option.x, option.y)
    await page.waitForFunction(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.length === 1, { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 300))
    const sent = await writes(page)
    assert.equal(sent.length, 1, "one click, one write")
    assert.equal(sent[0]!.permissionMode, "auto")
    // The whole object goes over — anything dropped here is a setting silently reset.
    assert.equal(sent[0]!.notifications, true)
    assert.equal("font" in sent[0]!, false)
    assert.equal(sent[0]!.autoCompactWindow, 500000)
    assert.ok(await page.$(PANEL), "picking a value leaves the panel open")
    assert.match(await page.$eval(PERMISSION, (el) => el.textContent ?? ""), /Auto/)
    assert.match(await page.$eval(PANEL, (el) => el.textContent ?? ""), /Saving…|Saved/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("Escape peels one layer at a time: Select, then panel, then picker", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await openPanel(page)
    await page.click(PERMISSION)
    await page.waitForSelector(SELECT_MENU)
    await page.keyboard.press("Escape")
    await page.waitForFunction((menu) => !document.querySelector(menu), {}, SELECT_MENU)
    assert.ok(await page.$(PANEL), "the first Escape closed only the Select")
    await page.keyboard.press("Escape")
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$(MENU), "the second Escape closed only the panel")
    await page.keyboard.press("Escape")
    await page.waitForFunction((menu) => !document.querySelector(menu), {}, MENU)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a click outside closes the panel and nothing else; the Codex band carries its own panel", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await openPanel(page)
    await page.mouse.click(8, 8)
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$(MENU), "the picker stays open under a dismissed panel")
    await page.click('button[aria-label="Codex settings"]')
    await page.waitForSelector('[data-agent-settings-menu="codex"] button[aria-label="Codex context window"]')
    assert.equal(await page.$('[data-agent-settings-menu="codex"] button[aria-label="Claude permission mode"]'), null, "the Codex panel carries no Claude field")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a settings write still in flight holds the composer until it lands", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?settingsDelay=1500")
  try {
    await openPanel(page)
    await page.click(PERMISSION)
    await page.waitForSelector(`${SELECT_ROW}[aria-checked="false"]`)
    const option = await center(page, `${SELECT_ROW}[aria-checked="false"]`)
    await page.mouse.click(option.x, option.y)
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.disabled === true, { timeout: 2000 })
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.disabled === false, { timeout: 5000 })
    assert.equal((await writes(page)).length, 1)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the launch prefix field saves what parses, holds back what does not, and keeps the other runtime's", { skip: !baseUrl, timeout: 60_000 }, async () => {
  // A 400ms save round-trip, so the typing below lands while writes are in flight.
  const { browser, page, errors } = await launch("?settingsDelay=400")
  const INPUT = `${PANEL} input[aria-label="Claude Code launch prefix"]`
  const prefixes = async () => (await writes(page)).map((w) => w.launchPrefix)
  try {
    await openPanel(page)
    await page.click(INPUT)
    await page.keyboard.type("op run --env-file .env --", { delay: 30 })
    // A caret moved mid-text and typed at while a save is in flight: nothing re-renders the box under it.
    await page.$eval(INPUT, (el) => (el as HTMLInputElement).setSelectionRange(2, 2))
    await page.keyboard.type(" -v", { delay: 30 })
    assert.deepEqual(await page.$eval(INPUT, (el) => [(el as HTMLInputElement).value, (el as HTMLInputElement).selectionStart]), ["op -v run --env-file .env --", 5])
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("op -v run --env-file .env -- claude"), { timeout: 3000 }, `${PANEL} [data-launch-prefix-preview]`)
    await page.waitForFunction(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.length >= 1, { timeout: 3000 })
    // Debounced: one burst of typing is one write, and it carries the whole object.
    await new Promise((r) => setTimeout(r, 1200))
    const sent = await writes(page)
    assert.equal(sent.length, 1, "a burst of typing is one write")
    assert.deepEqual(sent[0]!.launchPrefix, { claude: "op -v run --env-file .env --" })
    assert.equal(sent[0]!.autoCompactWindow, 500000)

    // Shell syntax is refused under the box, and never written.
    await page.keyboard.press("End")
    await page.keyboard.type(" | tee", { delay: 30 })
    await page.waitForSelector(`${PANEL} [role="alert"]`)
    assert.match(await page.$eval(`${PANEL} [role="alert"]`, (el) => el.textContent ?? ""), /shell syntax/)
    assert.equal(await page.$eval(INPUT, (el) => el.getAttribute("aria-invalid")), "true")
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal((await prefixes()).some((p) => JSON.stringify(p).includes("|")), false, "an invalid prefix is never saved")

    // The Codex panel writes its own key and leaves Claude's as stored.
    await page.keyboard.press("Escape")
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    await page.click('button[aria-label="Codex settings"]')
    const CODEX = '[data-agent-settings-menu="codex"] input[aria-label="Codex launch prefix"]'
    await page.waitForSelector(CODEX)
    await page.click(CODEX)
    await page.keyboard.type("nice -n 10", { delay: 20 })
    await page.waitForFunction(() => {
      const all = (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites
      return JSON.stringify(all.at(-1)?.launchPrefix) === JSON.stringify({ claude: "op -v run --env-file .env -- ", codex: "nice -n 10" })
    }, { timeout: 4000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
