import assert from "node:assert/strict"
import test, { after } from "node:test"
import type { Browser } from "puppeteer"

// A SIGNED-OUT PROVIDER IN THE MODEL PICKER. Its models were listed like any other's, and the first sign
// that a thread on one would not start was the sign-in at Send. The picker now says so beside the
// provider's name, in the desktop menu and in the phone's sheet, and still lets the model be picked.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_MODEL_PICKER_SIGNED_OUT_E2E_URL to its origin.
// model-edition-fixture marks providers signed out with `?signedOut=`, as useDispatchProfile does from
// the server's own reading of each credential.
const baseUrl = process.env.FRIZZ_MODEL_PICKER_SIGNED_OUT_E2E_URL

let sharedBrowser: Browser | undefined
after(async () => {
  if (!sharedBrowser) return
  const b = sharedBrowser
  sharedBrowser = undefined
  await b.close()
})

async function openPage(query: string, phone = false) {
  if (!sharedBrowser) {
    const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
    sharedBrowser = await launchHeadless({ protocolTimeout: 30_000 })
  }
  const page = await sharedBrowser.newPage()
  await page.setViewport(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 900, height: 700, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  try {
    await page.goto(`${baseUrl}/model-edition-fixture.html?view=dispatch${query}`, { waitUntil: "networkidle0" })
  } catch (error) {
    await page.close()
    throw error
  }
  return { page, errors }
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
  const { page, errors } = await openPage("&signedOut=codex")
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
    await page.close()
  }
})

test("a signed-in machine's menu says nothing", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage("")
  try {
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    assert.deepEqual(await headings(page), [{ name: "Claude Code", note: null }, { name: "Codex", note: null }])
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("the phone's sheet says it on the row that carries the provider's name", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage("&signedOut=codex", true)
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
    await page.close()
  }
})

test("Antigravity lists regular Gemini models in the effort grid and keeps Orchestrator and third-party models under Other models", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage("&antigravity=ultra&selected=gemini")
  try {
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    // Regular Gemini models sit directly in the matrix, abbreviated to <Family> <edition>, none truncated.
    const geminiRows = await page.$$eval("[data-profile-grid-row^='antigravity:']", (rows) =>
      rows.map((row) => {
        const label = row.querySelector(".profile-grid-model-label") as HTMLElement
        return {
          model: row.getAttribute("data-profile-grid-row"),
          text: label.textContent?.trim(),
          edition: label.querySelector(".profile-grid-edition")?.textContent?.trim() ?? null,
          truncated: label.scrollWidth > label.clientWidth + 0.5,
        }
      }),
    )
    assert.deepEqual(geminiRows.map((r) => [r.model, r.text, r.edition]), [
      ["antigravity:gemini-4-neon", "Neon 4", "4"],
      ["antigravity:gemini-4-carbon", "Carbon 4", "4"],
      ["antigravity:gemini-4-argon", "Argon 4", "4"],
      ["antigravity:gemini-4-hydrogen", "Hydrogen 4", "4"],
      ["antigravity:gemini-3.8-flash", "Flash 3.8", "3.8"],
    ])
    assert.deepEqual(geminiRows.filter((r) => r.truncated), [], "every native Gemini row fits without ellipsis")
    // One click picks a Gemini model and effort directly.
    await page.click("[data-profile-grid-row='antigravity:gemini-4-hydrogen'] [role='menuitemradio'][aria-label*='X-high']")
    await page.waitForSelector(".profile-grid-menu", { hidden: true })
    assert.match(await page.$eval(".profile-grid-trigger", (el) => el.textContent ?? ""), /Hydrogen 4 › xhigh/i)

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
    await page.close()
  }
})

test("on a phone Antigravity shows regular Gemini rows first and collapses Other models behind a toggle", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage("&antigravity=ultra&selected=gemini", true)
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
    await page.close()
  }
})

test("Codex lists only the frontier models in the grid, folds older versions under Other models, and Antigravity appears before OpenCode", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { page, errors } = await openPage("&codex=full&antigravity=ultra&opencode=native")
  try {
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    const groupNames = (await headings(page)).map((h) => h.name.replace(/\s*Experimental$/i, "").trim())
    assert.deepEqual(groupNames, ["Claude Code", "Codex", "Antigravity", "OpenCode"])
    const codexRows = await page.$$eval("[data-profile-grid-row^='gpt-']", (rows) =>
      rows.map((row) => row.getAttribute("data-profile-grid-row")),
    )
    assert.deepEqual(codexRows, ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-luna"])
    // Open Codex's Other models submenu and pick an older version: commits with its defaultEffort ("medium"), never "".
    await page.hover("[data-profile-grid-more='codex'] .profile-grid-dropdown")
    await page.waitForSelector(".profile-grid-submenu")
    const olderLabels = await page.$$eval('.profile-grid-submenu [role="menuitemradio"]', (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(olderLabels, ["GPT-6.1 Sol", "GPT-6 Astra", "GPT-6 Sol", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"])
    await page.evaluate(() => [...document.querySelectorAll('.profile-grid-submenu [role="menuitemradio"]')].find((el) => el.textContent?.trim() === "GPT-6 Astra")!.setAttribute("data-pick", ""))
    await page.click(".profile-grid-submenu [data-pick]")
    await page.waitForSelector(".profile-grid-menu", { hidden: true })
    assert.match(await page.$eval(".profile-grid-trigger", (el) => el.textContent ?? ""), /GPT-6 Astra › medium/i)

    // Reopening shows GPT-6 Astra active in the Other models row with its reasoning-level submenu.
    await page.click(".profile-grid-trigger")
    await page.waitForSelector(".profile-grid-menu")
    const moreTriggers = await page.$$eval("[data-profile-grid-more='codex'] .profile-grid-dropdown", (els) => els.map((el) => el.textContent?.trim()))
    assert.deepEqual(moreTriggers, ["GPT-6 Astra", "Medium"])
    await page.hover("[data-profile-grid-more='codex'] [aria-label='Codex reasoning level']")
    await page.waitForSelector(".profile-grid-submenu")
    await page.evaluate(() => [...document.querySelectorAll('.profile-grid-submenu [role="menuitemradio"]')].find((el) => el.textContent?.trim() === "X-high")!.setAttribute("data-pick", ""))
    await page.click(".profile-grid-submenu [data-pick]")
    await page.waitForSelector(".profile-grid-menu", { hidden: true })
    assert.match(await page.$eval(".profile-grid-trigger", (el) => el.textContent ?? ""), /GPT-6 Astra › xhigh/i)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
