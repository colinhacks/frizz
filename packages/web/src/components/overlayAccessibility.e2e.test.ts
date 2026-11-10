import assert from "node:assert/strict"
import test from "node:test"
import { MOBILE_MAX_PX } from "../lib/mobile.ts"

// Opt-in because this drives a real Frizz server and Chrome. Normal unit runs record the regression
// without requiring a listener; local/live verification supplies a disposable URL and session rows.
//
// FRIZZ_OVERLAY_E2E_URL is a PROJECT's board, not the server root: one server serves every project,
// and the bare origin is the project grid, which has no board and no Settings button. Working
// invocation (from the repo root, against a disposable stack):
//
//   nub scripts/adhoc-stack.mjs --port=47451            # first JSON line names `home` and `url`
//   nub scripts/seed-nested-subagents.mjs --home=<home>  # the nested sub-agent thread (first test)
//   nub scripts/seed-overlay-e2e.mjs --home=<home>       # the "Overlay E2E" thread (second test)
//   FRIZZ_OVERLAY_E2E_URL=http://127.0.0.1:47451/project/frizz FRIZZ_OVERLAY_E2E_NESTED_SLUG=nested-subagents \
//     nub run test packages/web/src/components/overlayAccessibility.e2e.test.ts
//
// A desktop board opens every thread in its one-thread pane and never in a sheet (store.paneEnabled, since
// 2026-11-09). So on a desktop the thread SHEET is opened over a status list (`/status/<status>?thread=`),
// the one board view with no pane; a phone board (MobileBoard) still opens one from the board's own
// `?thread=`. The pane gets its own check: a sub-agent drawer opened from it unwinds on Escape and leaves
// the pane's thread where it was.
//
// While the Mac sits idle, new headless Chrome can stop drawing frames after a tab's second
// navigation (see the headless-browser skill). The app keeps working, but puppeteer's
// requestAnimationFrame-polled waits never re-check, so a step whose state is already true times out
// (measured 2026-10-05: 3 of 6 runs, the sheet already closed and the route already rewritten).
// puppeteer's chrome-headless-shell keeps drawing (6 of 6), and since 2026-10-11 it is the only browser
// `launchHeadless()` starts.
const baseUrl = process.env.FRIZZ_OVERLAY_E2E_URL
const threadSlug = process.env.FRIZZ_OVERLAY_E2E_SLUG ?? "overlay-e2e"
const nestedThreadSlug = process.env.FRIZZ_OVERLAY_E2E_NESTED_SLUG
// The board's own path ("/project/frizz"): where closing the last sheet leaves the address bar.
const boardPath = baseUrl ? new URL(baseUrl).pathname.replace(/\/$/, "") || "/" : "/"

type AppStore = typeof import("../store.ts")
type StoreHandle = { frizzOverlayE2eStore: () => Promise<AppStore> }

// The tests reach the app's store to open and read drawers. A bare `import("/src/store.ts")` is NOT
// the app's store once vite has hot-updated anything since it started — the app then holds
// `/src/store.ts?t=<n>`, and the bare URL evaluates a second, empty instance whose `pushDrawer` opens
// nothing. Other agents edit this tree all day, so that is the common case on a live stack. This
// handle imports the exact URL the app itself loaded (the resource-timing buffer is widened first:
// vite's dev graph is far past the default 250 entries). Serialized into the page, so self-contained.
function installStoreHandle(): void {
  performance.setResourceTimingBufferSize(100_000)
  ;(globalThis as unknown as StoreHandle).frizzOverlayE2eStore = () => {
    const loaded = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((name) => new URL(name).pathname === "/src/store.ts")
    return import(loaded.at(-1) ?? "/src/store.ts")
  }
}

// adhoc-stack runs without the launcher supervisor. Only its unrelated status probe is stubbed; the
// board, transcript, drawer components and keyboard dispatch all run through the real app.
async function stubSupervisorStatus(page: import("puppeteer").Page): Promise<void> {
  await page.setRequestInterception(true)
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/_frizz/control/status") {
      void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
    } else void request.continue()
  })
}

// Seed with scripts/seed-nested-subagents.mjs against the disposable stack's HOME, then set
// FRIZZ_OVERLAY_E2E_NESTED_SLUG=nested-subagents alongside FRIZZ_OVERLAY_E2E_URL.
test("Escape unwinds nested subagent drawers without dismissing their session, or the pane's thread", {
  skip: !baseUrl || !nestedThreadSlug,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.evaluateOnNewDocument(installStoreHandle)
    await stubSupervisorStatus(page)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url}`) })
    const drawers = () => page.evaluate(async () => {
      const { store } = await (globalThis as unknown as StoreHandle).frizzOverlayE2eStore()
      return store.drawers.map((drawer: { kind: string; closing?: boolean }) => ({ kind: drawer.kind, closing: !!drawer.closing }))
    })
    const child = '[role="dialog"] [aria-label^="Open sub-agent transcript:"]'
    const drawerCount = (n: number) => page.waitForFunction(async (n) => {
      const { store } = await (globalThis as unknown as StoreHandle).frizzOverlayE2eStore()
      return store.drawers.filter((drawer: { closing?: boolean }) => !drawer.closing).length === n
    }, {}, n)
    for (const [width, font] of [[1440, "sans"], [390, "sans"], [1440, "mono"], [390, "mono"]] as const) {
      const desktop = width > MOBILE_MAX_PX
      await page.setViewport({ width, height: 900 })
      if (desktop) {
        // THE PANE FIRST: the board's own link shows the thread in its pane, and a sub-agent opened from
        // there is the one drawer over it. Escape closes that drawer and nothing else.
        await page.goto(`${baseUrl}?thread=${nestedThreadSlug}`, { waitUntil: "domcontentloaded" })
        await page.waitForSelector(`[data-subagent-parent="${nestedThreadSlug}"]`)
        await page.evaluate((font) => { document.documentElement.dataset.font = font }, font)
        const paneChild = '[data-pane-thread] [aria-label^="Open sub-agent transcript:"]'
        await page.waitForSelector(paneChild)
        await page.click(paneChild)
        // A sub-agent's sheet is an inline panel, not a Radix dialog (only ThreadSheet is one).
        await drawerCount(1)
        await page.waitForSelector(".frizz-sheet-panel")
        await page.keyboard.press("Escape")
        await drawerCount(0)
        await page.waitForFunction(() => !document.querySelector(".frizz-sheet-panel"))
        assert.ok(await page.$(`[data-pane-thread] [data-thread-surface="${nestedThreadSlug}"]`), "Escape left the pane's thread open")
        assert.equal(new URL(page.url()).searchParams.get("thread"), nestedThreadSlug)
      }
      // THE SHEET: on a desktop over a status list, on the phone over its board.
      const sheetRoute = desktop ? `${baseUrl}/status/active` : baseUrl
      await page.goto(`${sheetRoute}?thread=${nestedThreadSlug}`, { waitUntil: "domcontentloaded" })
      // Wait for the board to have drawn this thread with its live children. The desktop rail lists
      // each sub-agent as its own row (`data-subagent-parent`); the PHONE board (MobileBoard, below
      // MOBILE_MAX_PX) deliberately draws no sub-agent rows — one row per thread, a "· N agents" count
      // in their place — so there the thread's own row is the board's evidence. Either way the drill
      // under test is the TRANSCRIPT's Agent card below, which both widths render.
      await page.waitForSelector(desktop
        ? `[data-subagent-parent="${nestedThreadSlug}"]`
        : `[data-mobile-thread-row="${nestedThreadSlug}"]`)
      await page.evaluate((font) => { document.documentElement.dataset.font = font }, font)
      await page.waitForSelector(child)
      await page.click(child)
      await drawerCount(2)
      await page.keyboard.press("Escape")
      await page.waitForFunction(async () => {
        const { store } = await (globalThis as unknown as StoreHandle).frizzOverlayE2eStore()
        return store.drawers.length < 2
      })
      assert.deepEqual(await drawers(), [{ kind: "thread", closing: false }], "one Escape leaves the session drawer open")
      assert.ok(await page.$('[role="dialog"]'))
      assert.equal(new URL(page.url()).searchParams.get("thread"), nestedThreadSlug)
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

// Seed with scripts/seed-overlay-e2e.mjs: the "Overlay E2E" thread this test opens by its cold route.
test("dialog portals, nested Select Escape, and thread sheets keep their keyboard contracts", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(installStoreHandle)
  await stubSupervisorStatus(page)
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

  // Every model selector is a portaled DropdownMenu (role=menu) — the profile grid, and since the
  // shared Select moved onto the same primitive, every Select too; nothing renders a role=listbox any
  // more. Each registers in lib/selectOverlay, so it unwinds through its own layer: the first Escape
  // closes only the menu and hands focus back to its trigger, the next closes the parent dialog.
  async function dismissMenuThenDialog(triggerLabel: string): Promise<void> {
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[role=menu]"))
    assert.ok(await page.$("[role=dialog]"), "the menu Escape must leave its parent dialog open")
    // Radix restores the portaled menu's trigger on a queued focus-scope cleanup. Wait for that layer
    // to settle before exercising the next, intentionally separate Escape.
    await page.waitForFunction(
      (label) => document.activeElement?.getAttribute("aria-label") === label,
      { polling: 50, timeout: 5_000 },
      triggerLabel,
    )
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"))
  }

  async function reverseTab(): Promise<void> {
    await page.keyboard.down("Shift")
    await page.keyboard.press("Tab")
    await page.keyboard.up("Shift")
  }

  // The thread sheet's semantics on a cold route, read once the sheet has resolved its thread and drawn
  // its header (desktop and phone headers both carry data-thread-header). Before that the title is
  // the bare slug, which would race the label assertion.
  async function threadSheet(): Promise<{ label?: string; modal: string | null; path: string }> {
    await page.waitForSelector("[role=dialog] [data-thread-header]")
    return page.$eval("[role=dialog]", (dialog) => ({
      label: document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent?.trim(),
      modal: dialog.getAttribute("aria-modal"),
      path: `${location.pathname}${location.search}`,
    }))
  }

  try {
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 })
    await page.goto(baseUrl!, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('button[title="Settings"]')

    // Open from a real focused control so the close path can prove restoration.
    await page.focus('button[title="Settings"]')
    await page.evaluate(async () => {
      const { openNewThread } = await (globalThis as unknown as StoreHandle).frizzOverlayE2eStore()
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
    // The dispatch profile picker (ProfileGridSelector) replaced the separate Model select: one
    // trigger for model and effort, its grid portaled outside the dialog's DOM.
    const model = await page.waitForSelector('[role="dialog"] button[aria-label="Model and effort"]:not([disabled])')
    assert.ok(model)
    await model.focus()
    await page.keyboard.press("Enter")
    await page.waitForSelector('[role=menu][aria-label="Choose model and effort"]')
    assert.equal(await page.$eval("[role=menu]", (menu) => menu.closest("[role=dialog]")), null, "the picker's menu is portaled outside the dialog")
    assert.ok(await page.$("[role=dialog]"), "opening a portaled picker must leave its parent dialog mounted")
    await dismissMenuThenDialog("Model and effort")
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("title") === "Settings",
      { polling: 50, timeout: 5_000 },
    )
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("title")), "Settings")

    // A cold `?thread=` route must create the thread sheet immediately, labelled and holding focus. On a
    // desktop the sheet is deliberately NON-modal (ThreadSheet: `modal={narrow}`) so the rail beside it
    // stays live; at or below 800px it is a modal sheet (asserted at 390px below). A desktop board opens
    // the thread in its pane instead, so the desktop sheet is read over a status list. The sheet's
    // Chat|Doc tab strip — and with it the tablist/tabpanel contract this test once pinned here — was
    // removed on 2026-08-06 (6d00c75e) when the Doc tab lost its only destination; the sheet has one
    // surface and no tabs, so there is no arrow-key or tab-persistence contract left to drive.
    const statusPath = `${boardPath}/status/active`
    await page.goto(`${baseUrl}/status/active?thread=${encodeURIComponent(threadSlug)}`, { waitUntil: "domcontentloaded" })
    const desktopSheet = await threadSheet()
    assert.deepEqual(desktopSheet, { label: "Thread: Overlay E2E", modal: null, path: `${statusPath}?thread=${threadSlug}` })
    await expectFocusInsideDialog()

    // The same cold route survives a real hard reload: the sheet comes back, labelled, holding focus.
    await page.reload({ waitUntil: "domcontentloaded" })
    assert.deepEqual(await threadSheet(), desktopSheet)
    await expectFocusInsideDialog()

    // The live-thread model/effort menu is portaled outside the dialog DOM. Escape still dismisses
    // only that highest layer; the next Escape closes the sheet and rewrites the route to the list under it.
    const profileMenu = await page.waitForSelector('[role="dialog"] button[aria-label="Thread model and effort"]:not([disabled])')
    assert.ok(profileMenu)
    await profileMenu.focus()
    await page.keyboard.press("Enter")
    await page.waitForSelector("[role=menu]")
    assert.ok(await page.$("[role=dialog]"), "opening a portaled menu must leave its parent sheet mounted")
    await dismissMenuThenDialog("Thread model and effort")
    await page.waitForFunction((path) => location.pathname === path && location.search === "", {}, statusPath)

    // Repeat the essential portal/focus checks at the requested compact viewport, where the sheet is
    // modal.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}?thread=${encodeURIComponent(threadSlug)}`, { waitUntil: "domcontentloaded" })
    assert.deepEqual(await threadSheet(), { label: "Thread: Overlay E2E", modal: "true", path: `${boardPath}?thread=${threadSlug}` })
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
