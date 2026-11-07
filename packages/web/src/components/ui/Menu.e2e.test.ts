import assert from "node:assert/strict"
import test from "node:test"

// Opt-in because this drives a real Frizz server and Chrome. The live seam is intentional: the
// regression came from Radix's portal/focus/outside-pointer side effects, which SSR cannot observe.
// TWO slugs: _SLUG is a QUEUED (needs-you) thread — it has a card in the main column; _DRAWER_SLUG is a
// NON-queued session thread, deep-linked to raise the modal thread drawer. They must differ, because a
// queued thread deliberately has no drawer at all: its `/thread/<slug>` route scrolls to the card, and
// the card's arrow is now a new-tab LINK to the standalone page rather than a drawer trigger.
const baseUrl = process.env.FRIZZ_MENU_E2E_URL
const threadSlug = process.env.FRIZZ_MENU_E2E_SLUG
const drawerSlug = process.env.FRIZZ_MENU_E2E_DRAWER_SLUG

test("Snooze menu stays non-modal and preserves anchored menu interactions", {
  skip: !baseUrl || !threadSlug || !drawerSlug,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))

  const cardSelector = `[data-queue-card="${threadSlug}"]`
  // The header's alarm clock (SnoozeMenu). Addressed by its data attribute, not its label: the label is
  // the snooze state ("Snoozed until …") whenever one is set.
  const triggerSelector = `${cardSelector} button[data-snooze-menu]`

  async function openMenu(selector = triggerSelector): Promise<void> {
    await page.focus(selector)
    await page.keyboard.press("Enter")
    await page.waitForSelector('[role="menu"]')
  }

  async function expectNonModalRoot(): Promise<void> {
    assert.deepEqual(await page.evaluate(() => {
      const root = document.querySelector("#root")
      return {
        pointerEvents: document.body.style.pointerEvents,
        ariaHidden: root?.getAttribute("aria-hidden") ?? null,
        dataAriaHidden: root?.getAttribute("data-aria-hidden") ?? null,
      }
    }), {
      pointerEvents: "",
      ariaHidden: null,
      dataAriaHidden: null,
    })
  }

  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector(triggerSelector)

    const asideBefore = await page.$eval("aside", (aside) => {
      const rect = aside.getBoundingClientRect()
      return { left: rect.left, width: rect.width, visibility: getComputedStyle(aside).visibility }
    })
    await openMenu()
    await expectNonModalRoot()
    const desktopOpen = await page.evaluate((selector) => {
      const aside = document.querySelector("aside")!
      const rect = aside.getBoundingClientRect()
      return {
        aside: { left: rect.left, width: rect.width, visibility: getComputedStyle(aside).visibility },
        expanded: document.querySelector(selector)?.getAttribute("aria-expanded"),
        focusInsideMenu: Boolean(document.querySelector('[role="menu"]')?.contains(document.activeElement)),
      }
    }, triggerSelector)
    assert.deepEqual(desktopOpen.aside, asideBefore)
    assert.equal(desktopOpen.expanded, "true")
    assert.equal(desktopOpen.focusInsideMenu, true)

    // A real outside pointer target must receive the same click that dismisses the menu.
    await page.evaluate(() => {
      const target = document.createElement("button")
      target.id = "menu-outside-probe"
      target.textContent = "outside probe"
      target.style.position = "fixed"
      target.style.left = "0"
      target.style.bottom = "0"
      target.addEventListener("click", () => target.dataset.clicked = "true")
      document.body.append(target)
    })
    await page.click("#menu-outside-probe")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    assert.equal(await page.$eval("#menu-outside-probe", (target) => target.getAttribute("data-clicked")), "true")

    // Escape closes only the menu and returns focus to its trigger.
    await openMenu()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      { polling: 50, timeout: 5_000 },
      triggerSelector,
    )

    // Compact layout keeps the menu within the viewport without making the page behind it modal. 768 is
    // the narrowest width that still draws queue cards and a modal thread drawer with this menu in them:
    // below it the phone layout takes over, with no cards on the board and the drawer's verbs in its ⋯
    // sheet instead (MobileThreadActionsSheet), so a 390px viewport finds no trigger at all.
    await page.setViewport({ width: 768, height: 844, deviceScaleFactor: 1 })
    await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), triggerSelector)
    await openMenu()
    await expectNonModalRoot()
    const compactRect = await page.$eval('[role="menu"]', (menu) => {
      const rect = menu.getBoundingClientRect()
      return { left: rect.left, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    assert.ok(compactRect.left >= 0)
    assert.ok(compactRect.right <= compactRect.viewportWidth)
    assert.ok(compactRect.bottom <= compactRect.viewportHeight)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))

    // In the modal drawer, one Escape belongs to the menu; the drawer itself stays open.
    await page.goto(`${baseUrl}?thread=${encodeURIComponent(drawerSlug!)}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[role="dialog"][aria-modal="true"]')
    const drawerTrigger = '[role="dialog"] button[data-snooze-menu]'
    await openMenu(drawerTrigger)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    assert.ok(await page.$('[role="dialog"][aria-modal="true"]'))
    await page.waitForFunction(
      (selector) => document.activeElement === document.querySelector(selector),
      { polling: 50, timeout: 5_000 },
      drawerTrigger,
    )

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
