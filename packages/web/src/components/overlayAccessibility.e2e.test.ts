import assert from "node:assert/strict"
import test from "node:test"

// Opt-in because this drives a real Frizz server and Chrome. Normal unit runs record the regression
// without requiring a listener; local/live verification supplies a disposable URL and session row.
const baseUrl = process.env.FRIZZ_OVERLAY_E2E_URL
const threadSlug = process.env.FRIZZ_OVERLAY_E2E_SLUG ?? "overlay-e2e"
const nestedThreadSlug = process.env.FRIZZ_OVERLAY_E2E_NESTED_SLUG

// Seed with scripts/seed-nested-subagents.mjs against the disposable stack's HOME, then set
// FRIZZ_OVERLAY_E2E_NESTED_SLUG=nested-subagents alongside FRIZZ_OVERLAY_E2E_URL.
test("Escape unwinds nested subagent drawers without dismissing their session", {
  skip: !baseUrl || !nestedThreadSlug,
  timeout: 90_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    // adhoc-stack runs without the launcher supervisor. Only its unrelated status probe is stubbed;
    // the board, transcript, drawer components and keyboard dispatch all run through the real app.
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/_frizz/control/status") {
        void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void request.continue()
    })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url}`) })
    const drawers = () => page.evaluate(async () => {
      const path = "/src/store.ts"
      const { store } = await import(path)
      return store.drawers.map((drawer: { kind: string; closing?: boolean }) => ({ kind: drawer.kind, closing: !!drawer.closing }))
    })
    for (const [width, font] of [[1440, "sans"], [390, "sans"], [1440, "mono"], [390, "mono"]] as const) {
      await page.setViewport({ width, height: 900 })
      await page.goto(`${baseUrl}/thread/${nestedThreadSlug}`, { waitUntil: "domcontentloaded" })
      await page.waitForSelector(`[data-subagent-parent="${nestedThreadSlug}"]`)
      await page.evaluate((font) => { document.documentElement.dataset.font = font }, font)
      await page.evaluate(async (slug) => {
        const path = "/src/store.ts"
        const { pushDrawer } = await import(path)
        pushDrawer("thread", slug)
      }, nestedThreadSlug)
      const child = '[role="dialog"] [aria-label^="Open sub-agent transcript:"]'
      await page.waitForSelector(child)
      await page.click(child)
      await page.waitForFunction(async () => {
        const path = "/src/store.ts"
        const { store } = await import(path)
        return store.drawers.length === 2
      })
      await page.keyboard.press("Escape")
      await page.waitForFunction(async () => {
        const path = "/src/store.ts"
        const { store } = await import(path)
        return store.drawers.length < 2
      })
      assert.deepEqual(await drawers(), [{ kind: "thread", closing: false }], "one Escape leaves the session drawer open")
      assert.ok(await page.$('[role="dialog"]'))
      assert.ok(new URL(page.url()).pathname.endsWith(`/thread/${nestedThreadSlug}`))
      if (process.env.FRIZZ_OVERLAY_E2E_SHOTS) {
        await page.screenshot({ path: `${process.env.FRIZZ_OVERLAY_E2E_SHOTS}/escape-${width}-${font}.png` })
      }
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
      assert.deepEqual(await drawers(), [], "the next Escape closes the session")
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("dialog portals, nested Select Escape, and thread tabs keep their keyboard contracts", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  })
  const page = await browser.newPage()
  const errors: string[] = []
  const failedResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("response", (response) => {
    if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  async function expectFocusInsideDialog(): Promise<void> {
    assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("[role=dialog]")
      return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement))
    }), true)
  }

  async function dismissSelectThenDialog(): Promise<void> {
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[role=listbox]"))
    assert.ok(await page.$("[role=dialog]"), "the Select Escape must leave its parent dialog open")
    // Radix restores the portaled Select's trigger on a queued focus-scope cleanup. Wait for that
    // layer to settle before exercising the next, intentionally separate Escape.
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("role") === "combobox",
      { polling: 50, timeout: 5_000 },
    )
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"))
  }

  // The model/effort selector is a portaled DropdownMenu (role=menu), not a Select (role=listbox), so
  // it unwinds through its own layer: the first Escape closes only the menu, the next closes the sheet.
  async function dismissMenuThenDialog(): Promise<void> {
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[role=menu]"))
    assert.ok(await page.$("[role=dialog]"), "the menu Escape must leave its parent dialog open")
    // Radix restores the portaled menu's trigger on a queued focus-scope cleanup. Wait for that layer
    // to settle before exercising the next, intentionally separate Escape.
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Thread model and effort",
      { polling: 50, timeout: 5_000 },
    )
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"))
  }

  async function reverseTab(): Promise<void> {
    await page.keyboard.down("Shift")
    await page.keyboard.press("Tab")
    await page.keyboard.up("Shift")
  }

  try {
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('button[title="Settings"]')

    // Open from a real focused control so the close path can prove restoration.
    await page.focus('button[title="Settings"]')
    await page.evaluate(async () => {
      const storeModule = "/src/store.ts"
      const { openNewThread } = await import(storeModule)
      openNewThread()
    })
    await page.waitForSelector('[role="dialog"][aria-modal="true"]')
    const newThreadSemantics = await page.$eval('[role="dialog"]', (dialog) => {
      const labelledBy = dialog.getAttribute("aria-labelledby")
      return {
        name: labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : undefined,
        focused: dialog.contains(document.activeElement),
        focusedTag: document.activeElement?.tagName,
      }
    })
    assert.deepEqual(newThreadSemantics, { name: "New thread", focused: true, focusedTag: "TEXTAREA" })
    await reverseTab()
    await expectFocusInsideDialog()
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press("Tab")
      await expectFocusInsideDialog()
    }
    const model = await page.waitForSelector('[role="dialog"] button[aria-label="Model"]:not([disabled])')
    assert.ok(model)
    await model.focus()
    await page.keyboard.press("Enter")
    await page.waitForSelector("[role=listbox]")
    assert.ok(await page.$("[role=dialog]"), "opening a portaled Select must leave its parent dialog mounted")
    await dismissSelectThenDialog()
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("title") === "Settings",
      { polling: 50, timeout: 5_000 },
    )
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("title")), "Settings")

    // A cold /thread route must create the same modal sheet semantics immediately, including the
    // linked tab/panel IDs. Radix Tabs owns arrows while onValueChange still owns route persistence.
    await page.goto(`${baseUrl}/thread/${encodeURIComponent(threadSlug)}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[role="dialog"][aria-modal="true"] [role="tablist"]')
    await expectFocusInsideDialog()
    const initialTabs = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("[role=dialog]")!
      const selected = dialog.querySelector<HTMLElement>('[role=tab][aria-selected="true"]')!
      const controls = selected.getAttribute("aria-controls")
      const panel = controls ? document.getElementById(controls) : null
      return {
        label: dialog.getAttribute("aria-labelledby")
          ? document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent?.trim()
          : undefined,
        listLabel: dialog.querySelector('[role=tablist]')?.getAttribute("aria-label"),
        selected: selected.textContent?.trim(),
        panelRole: panel?.getAttribute("role"),
        panelLabelledBy: panel?.getAttribute("aria-labelledby"),
        selectedId: selected.id,
        path: location.pathname,
      }
    })
    assert.equal(initialTabs.label, "Thread: Overlay E2E")
    assert.equal(initialTabs.listLabel, "Thread view")
    assert.equal(initialTabs.selected, "Chat")
    assert.equal(initialTabs.panelRole, "tabpanel")
    assert.equal(initialTabs.panelLabelledBy, initialTabs.selectedId)
    assert.equal(initialTabs.path, `/thread/${threadSlug}`)

    await page.focus('[role=tab][aria-selected="true"]')
    await page.keyboard.press("ArrowRight")
    await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected="true"]')?.textContent?.trim() === "Terminal")
    assert.equal(await page.evaluate(() => location.pathname), `/thread/${threadSlug}`)

    // The controlled tab remains session-persisted across a real hard reload.
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected="true"]')?.textContent?.trim() === "Terminal")
    await expectFocusInsideDialog()
    await page.focus('[role=tab][aria-selected="true"]')
    await page.keyboard.press("ArrowLeft")
    await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected="true"]')?.textContent?.trim() === "Chat")

    // The live-thread model/effort menu is portaled outside the dialog DOM. Escape still dismisses
    // only that highest layer; the next Escape closes the sheet and rewrites the route to root.
    const profileMenu = await page.waitForSelector('[role="dialog"] button[aria-label="Thread model and effort"]:not([disabled])')
    assert.ok(profileMenu)
    await profileMenu.focus()
    await page.keyboard.press("Enter")
    await page.waitForSelector("[role=menu]")
    assert.ok(await page.$("[role=dialog]"), "opening a portaled menu must leave its parent sheet mounted")
    await dismissMenuThenDialog()
    await page.waitForFunction(() => location.pathname === "/")

    // Repeat the essential portal/focus checks at the requested compact viewport.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/thread/${encodeURIComponent(threadSlug)}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[role="dialog"][aria-modal="true"] [role="tablist"]')
    await expectFocusInsideDialog()
    const mobileGeometry = await page.$eval('[role="dialog"]', (dialog) => {
      const rect = dialog.getBoundingClientRect()
      return { left: rect.left, right: rect.right, viewport: innerWidth }
    })
    assert.ok(mobileGeometry.left >= 0)
    assert.ok(mobileGeometry.right <= mobileGeometry.viewport)
    await reverseTab()
    await expectFocusInsideDialog()

    assert.deepEqual(errors, [])
    assert.deepEqual(failedResponses, [])
  } finally {
    await browser.close()
  }
})
