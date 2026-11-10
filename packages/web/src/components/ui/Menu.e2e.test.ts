import assert from "node:assert/strict"
import test from "node:test"

// Opt-in because this drives a real Frizz server and Chrome. The live seam is intentional: the
// regression came from Radix's portal/focus/outside-pointer side effects, which SSR cannot observe.
// TWO slugs: _SLUG is a QUEUED (needs-you) thread, opened in the desktop board's one-thread pane with
// the snooze menu in its header; _DRAWER_SLUG is a SNOOZED thread, opened as a modal thread drawer over a
// status list. A desktop board opens EVERY thread in its pane and never a drawer (store.paneEnabled,
// since 2026-11-09), so the drawer comes from the one board view that has no pane: a status list,
// `/status/<status>?thread=<slug>`. At 800px and below that drawer is modal (useNarrowDrawer).
//
// Recipe. The URL is the stack's project board (its json line's "url"), not the bare origin, which is
// the project grid and has no board. seed-overlay-e2e.mjs seeds the snoozed drawer thread; the queued
// one is the same row unsnoozed under another slug and session. Keep the project rail off (a fresh
// stack's default; projectSwitch.e2e turns it on): the rail covers the bottom-left corner where the
// outside-click probe sits, so the probe never receives the click.
//   nub scripts/adhoc-stack.mjs --port=45790 --project=/abs/throwaway-repo > /tmp/stack.log 2>&1 &
//   nub scripts/seed-overlay-e2e.mjs --home=<home> --cwd=/abs/throwaway-repo
//   D=$(ls -d <home>/.claude/projects/*); S=0ae7e2e0-0000-4000-8000-00000000000
//   sed "s/${S}1/${S}2/g" "$D/${S}1.jsonl" > "$D/${S}2.jsonl"
//   sqlite3 <home>/.frizz/ui.db "CREATE TEMP TABLE t AS SELECT * FROM session WHERE slug='overlay-e2e';
//     UPDATE t SET slug='menu-queued', session_id='${S}2', thread_name='frizz-menu-queued', snoozed_until=NULL;
//     INSERT INTO session SELECT * FROM t;"
//   FRIZZ_MENU_E2E_URL=http://127.0.0.1:45790/project/<slug> FRIZZ_MENU_E2E_SLUG=menu-queued \
//     FRIZZ_MENU_E2E_DRAWER_SLUG=overlay-e2e nub run test packages/web/src/components/ui/Menu.e2e.test.ts
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

  // The pane's thread header's alarm clock (SnoozeMenu). Addressed by its data attribute, not its
  // label: the label is the snooze state ("Snoozed until …") whenever one is set.
  const triggerSelector = "[data-pane-thread] button[data-snooze-menu]"

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
    // The pane remembers full screen (sidebar put away) across loads; start from its default layout.
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    await page.goto(`${baseUrl}?thread=${encodeURIComponent(threadSlug!)}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector(triggerSelector, { timeout: 60_000 })

    const asideBefore = await page.$eval("[data-pane-sidebar] aside", (aside) => {
      const rect = aside.getBoundingClientRect()
      return { left: rect.left, width: rect.width, visibility: getComputedStyle(aside).visibility }
    })
    await openMenu()
    await expectNonModalRoot()
    const desktopOpen = await page.evaluate((selector) => {
      const aside = document.querySelector("[data-pane-sidebar] aside")!
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
    // a width that still draws the pane, and a modal thread drawer, with this menu in them: below 700 the
    // phone layout takes over, with no pane on the board and the drawer's verbs in its ⋯ sheet instead
    // (MobileThreadActionsSheet), so a 390px viewport finds no trigger at all.
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

    // In the modal drawer, one Escape belongs to the menu; the drawer itself stays open. The drawer opens
    // over a status list, the board view with no pane.
    await page.goto(`${baseUrl}/status/active?thread=${encodeURIComponent(drawerSlug!)}`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 60_000 })
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
