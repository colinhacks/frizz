import assert from "node:assert/strict"
import test from "node:test"

// A SIGNED-OUT PROVIDER IN THE MODEL PICKER. Its models were listed like any other's, and the first sign
// that a thread on one would not start was the sign-in at Send. The picker now says so beside the
// provider's name, in the desktop menu and in the phone's sheet, and still lets the model be picked.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_MODEL_PICKER_SIGNED_OUT_E2E_URL to its origin.
// model-edition-fixture marks providers signed out with `?signedOut=`, as useDispatchProfile does from
// the server's own reading of each credential.
const baseUrl = process.env.FRIZZ_MODEL_PICKER_SIGNED_OUT_E2E_URL

async function launch(query: string, phone = false) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 900, height: 700, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  try {
    await page.goto(`${baseUrl}/model-edition-fixture.html?view=dispatch${query}`, { waitUntil: "networkidle0" })
  } catch (error) {
    await browser.close()
    throw error
  }
  return { browser, page, errors }
}

/** Each provider heading in the open desktop menu: its name, and the note beside it if it has one. */
const headings = (page: import("puppeteer").Page) =>
  page.$$eval(".profile-grid-header", (rows) =>
    rows.map((row) => {
      const note = row.querySelector("[data-profile-grid-signed-out]")
      // What a screen reader is given of the note: its words, without the drawn separator.
      const spoken = note ? [...note.childNodes].filter((n) => !(n instanceof Element && n.getAttribute("aria-hidden") === "true")).map((n) => n.textContent).join("") : null
      return { name: (row.textContent ?? "").replace(note?.textContent ?? "", "").trim(), note: spoken }
    }),
  )

test("the desktop menu names a signed-out provider beside its heading, and its models can still be picked", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("&signedOut=codex")
  try {
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    assert.deepEqual(await headings(page), [{ name: "Claude Code", note: null }, { name: "Codex", note: "Not signed in" }])
    // Picking one of its models works as it always did. Send is where the sign-in is offered.
    await page.click("[data-profile-grid-row='gpt-6-astra'] [role='menuitemradio']")
    await page.waitForSelector(".profile-grid-menu", { hidden: true })
    assert.match(await page.$eval(".profile-grid-trigger", (el) => el.textContent ?? ""), /GPT-6 Astra/i)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a signed-in machine's menu says nothing", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("")
  try {
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    assert.deepEqual(await headings(page), [{ name: "Claude Code", note: null }, { name: "Codex", note: null }])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the phone's sheet says it on the row that carries the provider's name", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("&signedOut=codex", true)
  try {
    await page.waitForSelector("button")
    await page.tap("button")
    await page.waitForSelector("[data-mobile-model-row]")
    const rows = await page.$$eval("[data-mobile-model-row]", (rows) =>
      rows.map((row) => ({ model: row.getAttribute("data-mobile-model-row"), note: row.querySelector("[data-mobile-model-signed-out]")?.textContent ?? null })),
    )
    assert.deepEqual(rows.filter((row) => row.note).map((row) => row.model), ["gpt-6-astra"], "once, on the Codex group's first row")
    assert.equal(rows.find((row) => row.note)!.note, "Not signed in")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("Antigravity lists regular Gemini models in the effort grid and keeps Orchestrator and third-party models under Other models", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("&antigravity=ultra&selected=gemini")
  try {
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    // Regular Gemini models sit directly in the matrix, none truncated.
    const geminiRows = await page.$$eval("[data-profile-grid-row^='antigravity:']", (rows) =>
      rows.map((row) => {
        const label = row.querySelector(".profile-grid-model-label") as HTMLElement
        return { model: row.getAttribute("data-profile-grid-row"), truncated: label.scrollWidth > label.clientWidth + 0.5 }
      }),
    )
    assert.deepEqual(geminiRows.map((r) => r.model), [
      "antigravity:gemini-4-neon",
      "antigravity:gemini-4-carbon",
      "antigravity:gemini-4-argon",
      "antigravity:gemini-4-hydrogen",
      "antigravity:gemini-3.8-flash",
    ])
    assert.deepEqual(geminiRows.filter((r) => r.truncated), [], "every native Gemini row fits without ellipsis")
    // One click picks a Gemini model and effort directly.
    await page.click("[data-profile-grid-row='antigravity:gemini-4-hydrogen'] [role='menuitemradio'][aria-label*='X-high']")
    await page.waitForSelector(".profile-grid-menu", { hidden: true })
    assert.match(await page.$eval(".profile-grid-trigger", (el) => el.textContent ?? ""), /Gemini 4 Hydrogen › xhigh/i)

    // Non-Gemini models live under Other models and keep the Antigravity prefix in the trigger.
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    await page.hover("[data-profile-grid-more='antigravity'] .profile-grid-dropdown")
    await page.waitForSelector(".profile-grid-submenu")
    const otherLabels = await page.$$eval('.profile-grid-submenu [role="menuitemradio"]', (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(otherLabels, [
      "Orchestrator (Neon)",
      "Orchestrator (Carbon)",
      "Orchestrator (Argon)",
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
      "GPT-OSS 120B (Medium)",
    ])
    await page.evaluate(() => [...document.querySelectorAll('.profile-grid-submenu [role="menuitemradio"]')].find((el) => el.textContent?.trim() === "Claude Opus 5.5")!.setAttribute("data-pick", ""))
    await page.click(".profile-grid-submenu [data-pick]")
    await page.waitForSelector(".profile-grid-menu", { hidden: true })
    assert.match(await page.$eval(".profile-grid-trigger", (el) => el.textContent ?? ""), /Antigravity Claude Opus 5\.5/i)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on a phone Antigravity shows regular Gemini rows first and collapses Other models behind a toggle", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("&antigravity=ultra&selected=gemini", true)
  try {
    await page.waitForSelector("[data-phone-profile-chip]")
    await page.tap("[data-phone-profile-chip]")
    await page.waitForSelector("[data-mobile-model-sheet]")
    // Let the sheet's 200ms slide-up transition settle so the lower toggle row is at its resting y.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const initial = await page.$$eval("[data-mobile-model-row^='antigravity:']", (els) => els.map((el) => el.getAttribute("data-mobile-model-row")))
    assert.deepEqual(initial, [
      "antigravity:gemini-4-neon",
      "antigravity:gemini-4-carbon",
      "antigravity:gemini-4-argon",
      "antigravity:gemini-4-hydrogen",
      "antigravity:gemini-3.8-flash",
    ])
    await page.tap("[data-mobile-model-more='antigravity']")
    await page.waitForSelector("[data-mobile-model-row='antigravity:gemini-pro-orchestrator-neon']")
    await page.evaluate(() => document.querySelector("[data-mobile-model-row='antigravity:gemini-pro-orchestrator-neon']")?.scrollIntoView({ block: "center" }))
    await page.tap("[data-mobile-model-row='antigravity:gemini-pro-orchestrator-neon']")
    await page.keyboard.press("Escape")
    await page.waitForSelector("[data-mobile-model-sheet]", { hidden: true })
    assert.match(await page.$eval("[data-phone-profile-chip]", (el) => el.textContent ?? ""), /Antigravity Orchestrator \(Neon\)/i)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
