import assert from "node:assert/strict"
import test from "node:test"

// THE HOME SWITCHER (HomeSwitcher.tsx) and the grid's forward to a kept Console (routes.tsx GridRoute).
//
//   · Its tabs are links: each has the address it goes to, so hovering one shows it and ⌘-click opens it.
//     They were buttons until 2026-10-23.
//   · The lit tab is the page on screen. It read the kept home, which every tab shares through the
//     storage event, so choosing Projects in one tab lit "Projects" over the Console in another.
//   · The Projects tab's address reaches the grid even while the Console is the kept home, opened in a
//     new tab as well as clicked, and the grid records the choice.
//   · Only a bare `/` forwards to the kept Console: the launcher's `/?add=<dir>` offer reached the grid's
//     dialog only while Projects was the kept home.
//   · The houses — the status row's and the rail's — go to the grid even while the Console is the kept
//     home. They followed the kept home until 2026-10-27, so on the Console the house went nowhere.
//   · On the Console it sits at the top-left of the sidebar — its left edge on the prompt box's, above
//     the status row — with the rail and without it, wide and stacked. It was centred over the page
//     until 2026-10-26.
//   · On the grid it heads the page, centred over the project icons where the home screen's search field
//     was mocked (2026-11-03), and the rail is hidden there, since the grid is the rail drawn larger.
//     From 2026-10-26 until then it stood in the Console's corner on the grid too.
//
// Real server, one project (nothing is dispatched):
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<throwaway repo>
//   FRIZZ_HOME_SWITCHER_E2E_URL=http://127.0.0.1:<port> FRIZZ_HOME_SWITCHER_E2E_ADD_DIR=<another repo, not added> \
//     nub run test <this file>
const baseUrl = process.env.FRIZZ_HOME_SWITCHER_E2E_URL
const addDir = process.env.FRIZZ_HOME_SWITCHER_E2E_ADD_DIR

const KEY = "frizz:home-view"
const TABS = "[data-home-tab]"

type Page = import("puppeteer").Page

const tabsOf = (page: Page) =>
  page.$$eval(TABS, (els) =>
    els.map((el) => ({ tag: el.tagName, tab: el.getAttribute("data-home-tab"), href: el.getAttribute("href"), selected: el.getAttribute("aria-selected") })),
  )
const lit = async (page: Page) => (await tabsOf(page)).filter((t) => t.selected === "true").map((t) => t.tab)
const kept = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY)
const at = (page: Page) => page.evaluate(() => location.pathname + location.search)
const onGrid = (page: Page) => page.waitForFunction(() => location.pathname === "/" && document.querySelector("[data-home-grid]") !== null, { timeout: 15_000 })

test("the home switcher's tabs are links, and the lit tab is the page on screen", { skip: !baseUrl || !addDir, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  const open = async () => {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    page.on("pageerror", (e) => errors.push(String(e)))
    return page
  }
  try {
    // One browser, so the pages share localStorage and see each other's storage events, as two tabs do.
    const here = await open()
    await here.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await here.waitForSelector('[data-home-tab="console"][aria-selected="true"]')
    assert.equal(await kept(here), "console", "arriving on the Console keeps it as home")
    assert.deepEqual(await tabsOf(here), [
      { tag: "A", tab: "projects", href: "/?home=projects", selected: "false" },
      { tag: "A", tab: "console", href: "/console", selected: "true" },
    ])
    const house = '[data-status-row] a[aria-label]'
    assert.equal(await here.$eval(house, (a) => a.getAttribute("href")), "/?home=projects", "the house goes to the grid, not the kept Console")

    // A bare `/` still forwards to the kept Console.
    const other = await open()
    await other.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    await other.waitForFunction(() => location.pathname === "/console", { timeout: 15_000 })

    // The other tab clicks Projects: it lands on the grid at a plain `/`, Projects lit and kept.
    await other.waitForSelector('[data-home-tab="projects"]')
    await other.click('[data-home-tab="projects"]')
    await onGrid(other)
    await other.waitForFunction((key) => localStorage.getItem(key) === "projects" && location.search === "", { timeout: 5_000 }, KEY)
    assert.deepEqual(await lit(other), ["projects"])

    // This tab, still on the Console, hears the choice and keeps Console lit, because Console is what
    // it shows.
    await here.waitForFunction((key) => localStorage.getItem(key) === "projects", { timeout: 5_000 }, KEY)
    assert.equal(await at(here), "/console")
    assert.deepEqual(await lit(here), ["console"], "another tab's choice does not light Projects over this Console")

    // Back to the Console as home, then ⌘-click Projects: a new tab opens on the grid, not the Console,
    // and this tab stays where it is.
    await here.reload({ waitUntil: "networkidle2" })
    await here.waitForFunction((key) => localStorage.getItem(key) === "console", { timeout: 5_000 }, KEY)
    const before = new Set(browser.targets())
    await here.keyboard.down("Meta")
    await here.click('[data-home-tab="projects"]')
    await here.keyboard.up("Meta")
    const target = await browser.waitForTarget((t) => t.type() === "page" && !before.has(t), { timeout: 10_000 })
    const opened = (await target.page())!
    opened.on("pageerror", (e) => errors.push(String(e)))
    await onGrid(opened)
    await opened.waitForFunction((key) => localStorage.getItem(key) === "projects" && location.search === "", { timeout: 5_000 }, KEY)
    assert.equal(await at(here), "/console", "a ⌘-click does not navigate the tab it was made in")

    // The launcher's offer to add a folder reaches the grid's dialog while the Console is kept.
    await here.reload({ waitUntil: "networkidle2" })
    await here.waitForFunction((key) => localStorage.getItem(key) === "console", { timeout: 5_000 }, KEY)
    const offer = await open()
    await offer.goto(`${baseUrl}/?add=${encodeURIComponent(addDir!)}`, { waitUntil: "networkidle2" })
    await offer.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Add this folder as a project?"), { timeout: 15_000 })
    assert.equal(await offer.evaluate(() => location.pathname), "/", "the offer is not forwarded to the Console")
    assert.equal(await kept(offer), "console", "an offer is not a choice of home")

    // The house, clicked on the Console while the Console is the kept home, lands on the grid at a plain
    // `/` (maintainer 2026-10-27). It went to `/console` — the page it was clicked on — until then.
    await here.click(house)
    await onGrid(here)
    assert.equal(await at(here), "/")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the home switcher stands at the top-left of the Console's sidebar, and heads the grid", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const settings = (await api.query("settingsGet")) as Record<string, unknown>
  const browser = await launchHeadless()
  const errors: string[] = []
  const box = (page: Page, sel: string) =>
    page.$eval(sel, (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, bottom: r.bottom }
    })
  try {
    // The rail moves the whole page 57px right, so the corner is checked with it shown and hidden. The
    // two narrow widths are the narrowest side-by-side sidebar (272px, the pill must fit inside it) and
    // the stacked layout above the phone breakpoint.
    for (const projectRail of [false, true]) {
      await api.mutate("settingsSet", { ...settings, projectRail })
      for (const width of [1440, 820, 760]) {
        const page = await browser.newPage()
        page.on("pageerror", (e) => errors.push(String(e)))
        await page.setViewport({ width, height: 900 })
        await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
        await page.waitForSelector("[data-console-sidebar] [data-status-row]")
        // The rail follows the server's setting, which can land a round trip after the first paint.
        // (Below 800px the page drops its inset whether or not the rail shows.)
        await page.waitForFunction((shown) => !!document.querySelector('nav[aria-label="Projects"]') === shown, { timeout: 10_000 }, projectRail)
        const where = `${width}px, rail ${projectRail ? "shown" : "hidden"}`
        const pill = await box(page, "[data-home-switcher]")
        const status = await box(page, "[data-console-sidebar] [data-status-row]")
        const sidebar = await page.$eval("[data-console-sidebar]", (el) => el.getBoundingClientRect().right)
        const pillRight = await page.$eval("[data-home-switcher]", (el) => el.getBoundingClientRect().right)
        assert.ok(Math.abs(pill.x - status.x) < 0.5, `${where}: the pill's left edge ${pill.x} is the status row's ${status.x}`)
        assert.ok(pill.bottom <= status.y, `${width}px: the pill ends (${pill.bottom}) above the status row (${status.y})`)
        assert.ok(pillRight <= sidebar, `${where}: the pill (right ${pillRight}) fits in the sidebar (right ${sidebar})`)
        // The Projects tab lands on the grid, where the one pill heads the page, centred over the icons
        // and above them, and the rail is out of the way: hidden, with no inset kept for it.
        await page.click('[data-home-tab="projects"]')
        await onGrid(page)
        const onTheGrid = await page.evaluate(() => {
          const pills = document.querySelectorAll("[data-home-switcher]")
          const p = pills[0].getBoundingClientRect()
          const g = document.querySelector("[data-home-grid]")!.getBoundingClientRect()
          const rail = document.querySelector('nav[aria-label="Projects"]')
          return {
            pills: pills.length,
            frames: document.querySelectorAll("[data-home-switcher-frame]").length,
            centreOffset: (p.left + p.right) / 2 - (g.left + g.right) / 2,
            above: p.bottom < g.top,
            railWidth: rail ? rail.getBoundingClientRect().width : 0,
            inset: getComputedStyle(document.querySelector("[data-home-grid-page]")!.parentElement!).paddingLeft,
          }
        })
        assert.equal(onTheGrid.pills, 1, `${where}: one pill on the grid`)
        assert.equal(onTheGrid.frames, 0, `${where}: the Console's fixed corner is not drawn on the grid`)
        assert.ok(Math.abs(onTheGrid.centreOffset) < 1, `${where}: the pill is centred over the grid (off by ${onTheGrid.centreOffset})`)
        assert.ok(onTheGrid.above, `${where}: the pill heads the grid`)
        assert.equal(onTheGrid.railWidth, 0, `${where}: the rail is hidden on the grid`)
        assert.equal(onTheGrid.inset, "0px", `${where}: the grid keeps no inset for a hidden rail`)
        // The rail's house, clicked on the Console with the Console kept, lands on the grid too, and wears
        // no Console count (the switcher's tab does).
        if (projectRail && width > 800) {
          await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
          await page.waitForSelector("[data-rail-home]")
          assert.equal(await page.$eval("[data-rail-home]", (a) => a.getAttribute("aria-current")), null, `${where}: the house is not the Console`)
          assert.equal(await page.$("[data-rail-home] [aria-label$='in the queue']"), null, `${where}: the house wears no queue count`)
          await page.click("[data-rail-home]")
          await onGrid(page)
          assert.equal(await at(page), "/", `${where}: the rail's house lands on a plain /`)
        }
        await page.close()
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await api.mutate("settingsSet", settings)
    await browser.close()
  }
})
