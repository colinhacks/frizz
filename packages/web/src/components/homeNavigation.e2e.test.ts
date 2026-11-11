import assert from "node:assert/strict"
import test from "node:test"

// THE WAY BETWEEN THE TWO HOMES, the grid at `/` and the Console at `/console` (lib/homeView.ts), now that no
// switcher stands between them. A Projects | Console pill headed both pages until 2026-11-10 (maintainer: "we
// just drop the entire tab switcher between console and the projects page").
//
//   · Neither page draws a pill.
//   · The grid's way to the Console is a line under the icons (ProjectGrid.tsx ConsoleLink), drawn once there
//     are two projects: with one, the Console is that project's board again. It is a link, so ⌘-click works.
//   · The Console's way out is the house at the head of its status row, before the project chip, and like
//     every house it goes to the grid even while the Console is the kept home.
//   · A bare `/` forwards to a kept Console; the launcher's `/?add=<dir>` offer does not.
//   · The grid's icons stand in the middle of the page when they do not fill a row.
//   · A Console over projects that have never run a thread is the centred first-task box, as a new project's
//     board is (maintainer 2026-11-10), with the Console's house and chip over it. The first task sent from it
//     goes to the project the chip names, and the Console becomes the sidebar and the pane, a reload included.
//   · With no project at all, `/console` forwards to the grid's welcome, which keeps the grid as home.
//
// Real server, one project with no threads, and the scripted stand-in for `claude` (it holds no login, so it
// raises no keychain dialog). The test adds a second project, sends one scripted task to it, takes the
// launching project out of the registry for a moment, and puts the registry back as it was:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<throwaway repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_HOME_NAV_E2E_URL=http://127.0.0.1:<port> FRIZZ_HOME_NAV_E2E_ADD_DIR=<another repo, not added> \
//     nub run test <this file>
const baseUrl = process.env.FRIZZ_HOME_NAV_E2E_URL
const addDir = process.env.FRIZZ_HOME_NAV_E2E_ADD_DIR

const KEY = "frizz:home-view"
const HOUSE = '[data-status-row] a[aria-label="All projects"]'

type Page = import("puppeteer").Page
type Project = { id: string; slug: string; path: string }

const kept = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY)
const at = (page: Page) => page.evaluate(() => location.pathname + location.search)
const onGrid = (page: Page) => page.waitForFunction(() => location.pathname === "/" && document.querySelector("[data-home-grid]") !== null, { timeout: 15_000 })
const pills = (page: Page) => page.evaluate(() => document.querySelectorAll("[data-home-switcher], [data-home-tab], [role='tablist'][aria-label='Home']").length)

test("no switcher: the grid links to the Console once there are two projects, and the Console's house goes back; a Console with no thread is the first-task box", { skip: !baseUrl || !addDir, timeout: 180_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const [launching] = (await api.query("projectsList")) as Project[]
  assert.ok(launching, "the stack registers its project")
  const browser = await launchHeadless()
  const errors: string[] = []
  const open = async (width = 1440) => {
    const page = await browser.newPage()
    await page.setViewport({ width, height: 900 })
    page.on("pageerror", (e) => errors.push(String(e)))
    return page
  }
  let added: Project | undefined
  try {
    // ONE PROJECT: the grid draws its icons in the middle of the page, no pill, and no Console link.
    const page = await open()
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    await onGrid(page)
    await page.waitForSelector(`[data-home-tile="${launching.slug}"]`)
    assert.equal(await pills(page), 0, "the grid draws no pill")
    assert.equal(await page.$("[data-home-console]"), null, "one project: the Console would be its board again")
    const centre = await page.evaluate(() => {
      const cells = [...document.querySelectorAll("[data-home-grid] > *")].map((el) => el.getBoundingClientRect())
      const left = Math.min(...cells.map((r) => r.left))
      const right = Math.max(...cells.map((r) => r.right))
      return (left + right) / 2 - innerWidth / 2
    })
    assert.ok(Math.abs(centre) < 1, `the icons stand in the middle of the page (off by ${centre})`)

    // TWO PROJECTS: the line under the icons links to the Console.
    added = (await api.mutate("projectAdd", { path: addDir })) as Project
    // The Console lists the projects the server has opened, and a test stack opens one on its first read.
    await createRpcClient(`${baseUrl}/`, added.id).query("board")
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector("[data-home-console]")
    assert.equal(await page.$eval("[data-home-console]", (a) => a.getAttribute("href")), "/console")
    assert.match(await page.$eval("[data-home-console]", (a) => a.textContent ?? ""), /^Console·every project's queue on one page$/)
    await page.click("[data-home-console]")
    await page.waitForFunction(() => location.pathname === "/console", { timeout: 15_000 })
    await page.waitForSelector(HOUSE)
    assert.equal(await pills(page), 0, "the Console draws no pill")
    assert.equal(await kept(page), "console", "arriving on the Console keeps it as home")

    // No project has run a thread: the Console is the centred first-task box, not a sidebar beside an empty
    // inbox, and its status row is the house, the slash, then the project chip.
    const firstTask = await page.evaluate(() => {
      const box = document.querySelector("[data-composer-box]")!.getBoundingClientRect()
      return {
        sidebar: document.querySelector("[data-console-sidebar]") !== null,
        heading: [...document.querySelectorAll("h2")].some((h) => h.textContent === "What should the agent do?"),
        centreOffset: (box.left + box.right) / 2 - innerWidth / 2,
        row: [...document.querySelector("[data-status-row] nav[aria-label='Breadcrumb']")!.children].map((el) =>
          el.matches("a[aria-label='All projects']") ? "house" : el.textContent === "/" ? "/" : el.querySelector("[data-console-project-chip]") ? "chip" : "?",
        ),
      }
    })
    assert.equal(firstTask.sidebar, false, "no sidebar on a Console with no thread")
    assert.equal(firstTask.heading, true)
    assert.ok(Math.abs(firstTask.centreOffset) < 1, `the prompt box stands in the middle of the page (off by ${firstTask.centreOffset})`)
    assert.deepEqual(firstTask.row, ["house", "/", "chip"])
    assert.equal(await page.$eval(HOUSE, (a) => a.getAttribute("href")), "/?home=projects")

    // A bare `/` forwards to the kept Console; the launcher's offer to add a folder does not.
    const other = await open()
    await other.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    await other.waitForFunction(() => location.pathname === "/console", { timeout: 15_000 })
    const offer = await open()
    await offer.goto(`${baseUrl}/?add=${encodeURIComponent(addDir!)}`, { waitUntil: "networkidle2" })
    await offer.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Add this folder as a project?"), { timeout: 15_000 })
    assert.equal(await offer.evaluate(() => location.pathname), "/", "the offer is not forwarded to the Console")
    assert.equal(await kept(offer), "console", "an offer is not a choice of home")
    await offer.close()

    // ⌘-click on the Console's house opens the grid in a new tab and leaves this one where it is.
    const before = new Set(browser.targets())
    await page.keyboard.down("Meta")
    await page.click(HOUSE)
    await page.keyboard.up("Meta")
    const target = await browser.waitForTarget((t) => t.type() === "page" && !before.has(t), { timeout: 10_000 })
    const opened = (await target.page())!
    opened.on("pageerror", (e) => errors.push(String(e)))
    await onGrid(opened)
    await opened.waitForFunction((key) => localStorage.getItem(key) === "projects" && location.search === "", { timeout: 5_000 }, KEY)
    assert.equal(await at(page), "/console", "a ⌘-click does not navigate the tab it was made in")
    await opened.close()

    // A plain click on the house lands on the grid at a plain `/`, and keeps the grid as home.
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForFunction((key) => localStorage.getItem(key) === "console", { timeout: 5_000 }, KEY)
    await page.waitForSelector(HOUSE)
    await page.click(HOUSE)
    await onGrid(page)
    await page.waitForFunction((key) => localStorage.getItem(key) === "projects" && location.search === "", { timeout: 5_000 }, KEY)
    assert.equal(await at(page), "/")

    // The house on a project page goes to the grid too, while the Console is the kept home.
    await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await page.waitForFunction((key) => localStorage.getItem(key) === "console", { timeout: 5_000 }, KEY)
    await page.goto(`${baseUrl}/project/${launching.slug}`, { waitUntil: "domcontentloaded" })
    const boardHouse = '[data-status-row] a[aria-label="All projects"]'
    await page.waitForSelector(boardHouse)
    await page.click(boardHouse)
    await onGrid(page)
    assert.equal(await at(page), "/")

    // THE FIRST TASK, sent from the Console's box to the project its chip names: it lands there and nowhere
    // else, and the Console becomes the sidebar and the pane, and stays so through a reload.
    await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-console-project-chip]")
    await page.click("[data-console-project-chip]")
    await page.waitForSelector(`[data-console-project-option="${added.slug}"]`)
    await page.click(`[data-console-project-option="${added.slug}"]`)
    await page.waitForFunction((slug) => document.querySelector("[data-console-project-chip]")?.getAttribute("data-console-project-chip") === slug, { timeout: 5_000 }, added.slug)
    await page.click("[data-composer-box] textarea")
    await page.keyboard.type("[script ending=done paras=1] Write the README")
    await page.keyboard.down("Meta")
    await page.keyboard.press("Enter")
    await page.keyboard.up("Meta")
    await page.waitForSelector("[data-console-sidebar] [data-sidebar-item]", { timeout: 30_000 })
    const sent = (await createRpcClient(`${baseUrl}/`, added.id).query("board")) as { threads: { id: string }[] }
    const stayed = (await createRpcClient(`${baseUrl}/`, launching.id).query("board")) as { threads: { id: string }[] }
    assert.equal(sent.threads.length, 1, "the task went to the project the chip named")
    assert.equal(stayed.threads.length, 0, "and to no other")
    assert.equal(await page.$("[data-console-sidebar]") !== null && await page.$("[data-pane-layout]") !== null, true, "the sidebar and the pane")
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector("[data-console-sidebar] [data-sidebar-item]", { timeout: 15_000 })

    // NO PROJECT AT ALL: the Console has nothing to show and nowhere to send a prompt, so it forwards to the
    // welcome, and the grid becomes the kept home (or a bare `/` would bounce back).
    // With its threads, so a second run starts from a project that has never run one.
    await api.mutate("projectRemove", { id: added.id, deleteData: true })
    added = undefined
    await api.mutate("projectRemove", { id: launching.id })
    try {
      await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
      await page.waitForFunction(() => location.pathname === "/" && document.body.textContent?.includes("Welcome to Frizz"), { timeout: 15_000 })
      assert.equal(await kept(page), "projects")
      assert.equal(await page.$("[data-console-sidebar]"), null, "no empty Console sidebar is left behind")
    } finally {
      await api.mutate("projectAdd", { path: launching.path })
    }

    assert.deepEqual(errors, [])
  } finally {
    if (added) await api.mutate("projectRemove", { id: added.id, deleteData: true }).catch(() => {})
    await browser.close()
  }
})

test("the rail stays out of the grid, and its house lands on a plain /", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const settings = (await api.query("settingsGet")) as Record<string, unknown>
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    await api.mutate("settingsSet", { ...settings, projectRail: true })
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-rail-home]")
    assert.equal(await page.$eval("[data-rail-home]", (a) => a.getAttribute("aria-current")), null, "the house is not the Console")
    assert.equal(await page.$("[data-rail-home] [aria-label$='in the queue']"), null, "the house wears no queue count")
    await page.click("[data-rail-home]")
    await onGrid(page)
    assert.equal(await at(page), "/", "the rail's house lands on a plain /")
    // The grid is the rail drawn larger, so the rail is hidden there, with no inset kept for it.
    const grid = await page.evaluate(() => {
      const rail = document.querySelector('nav[aria-label="Projects"]')
      return {
        railWidth: rail ? rail.getBoundingClientRect().width : 0,
        inset: getComputedStyle(document.querySelector("[data-home-grid-page]")!.parentElement!).paddingLeft,
      }
    })
    assert.equal(grid.railWidth, 0, "the rail is hidden on the grid")
    assert.equal(grid.inset, "0px", "the grid keeps no inset for a hidden rail")
    assert.deepEqual(errors, [])
  } finally {
    await api.mutate("settingsSet", settings)
    await browser.close()
  }
})
