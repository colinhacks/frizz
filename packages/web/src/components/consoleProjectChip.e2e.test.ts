import assert from "node:assert/strict"
import test from "node:test"

// THE CONSOLE'S PROJECT CHIP (ConsoleProjectChip.tsx): at the upper left of the status row, over the prompt
// box it points, where the house stood until 2026-11-06. Clicking a row of its menu picks the project a
// prompt goes to. Each row's icon opens that project in a new tab, and that must not move the pick: the two
// sit on one row, and a pick nobody meant sends the next thread to the wrong project.
//
// Real server, two projects (nothing is dispatched):
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<throwaway repo> --also-project=<another>
//   FRIZZ_CONSOLE_PROJECT_CHIP_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
const baseUrl = process.env.FRIZZ_CONSOLE_PROJECT_CHIP_E2E_URL

const CHIP = "[data-console-project-chip]"
const PICK_KEY = "frizz:console-dispatch-project"

test("the chip leads the status row, and its menu picks a project or opens one in a new tab", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  // The Console lists the projects the server has opened, and a server opens one on its first read.
  const projects = (await createRpcClient(`${baseUrl}/`).query("projectsList")) as { id: string }[]
  await Promise.all(projects.map((project) => createRpcClient(`${baseUrl}/`, project.id).query("board")))
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`[data-status-row] ${CHIP}`)

    const place = await page.evaluate((chip) => {
      const box = document.querySelector("[data-composer-box]")!
      const row = document.querySelector("[data-status-row]")!
      const first = row.firstElementChild!
      const square = first.querySelector("*")!.getBoundingClientRect()
      return {
        leads: first.matches(chip),
        inBox: box.querySelector(chip) !== null,
        above: first.getBoundingClientRect().bottom <= box.getBoundingClientRect().top,
        squareToBoxEdge: Math.abs(square.left - box.getBoundingClientRect().left),
        house: row.querySelector('a[aria-label="All projects"]') !== null,
      }
    }, CHIP)
    assert.deepEqual(place, { leads: true, inBox: false, above: true, squareToBoxEdge: 0, house: false })

    const shown = () => page.$eval(CHIP, (el) => el.getAttribute("data-console-project-chip")!)
    const start = await shown()
    const openMenu = async () => {
      await page.click(CHIP)
      await page.waitForSelector("[data-console-project-option]")
    }
    const closed = () => page.waitForFunction(() => !document.querySelector("[data-console-project-option]"), { timeout: 5_000 })

    await openMenu()
    const slugs = await page.$$eval("[data-console-project-option]", (rows) => rows.map((r) => r.getAttribute("data-console-project-option")!))
    assert.equal(slugs.length, 2)
    const other = slugs.find((slug) => slug !== start)!
    const link = `a[data-console-project-open="${other}"]`
    assert.deepEqual(await page.$eval(link, (a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), label: a.getAttribute("aria-label") })), {
      href: `/project/${other}`,
      target: "_blank",
      label: await page.$eval(`[data-console-project-option="${other}"] .truncate`, (name) => `Open ${name.textContent} in a new tab`),
    })

    // The icon opens the other project in a new tab, closes the menu and leaves the pick alone.
    const before = new Set(browser.targets())
    await page.click(link)
    const target = await browser.waitForTarget((t) => t.type() === "page" && !before.has(t), { timeout: 10_000 })
    assert.equal(new URL(target.url()).pathname, `/project/${other}`)
    await (await target.page())!.close()
    // A tab behind the new one draws no frames, and puppeteer's click waits on one.
    await page.bringToFront()
    await closed()
    assert.equal(await shown(), start, "opening a project does not pick it")
    assert.notEqual(await page.evaluate((key) => localStorage.getItem(key), PICK_KEY), other)

    // The arrow keys reach the icon, because it is a menu item of its own.
    await openMenu()
    const focused = (selector: string) => page.waitForFunction((s) => document.activeElement?.matches(s), { timeout: 3_000 }, selector)
    await page.keyboard.press("ArrowDown")
    await focused(`[data-console-project-option="${slugs[0]}"]`)
    await page.keyboard.press("ArrowDown")
    await focused(`a[data-console-project-open="${slugs[0]}"]`)
    await page.keyboard.press("ArrowDown")
    await focused(`[data-console-project-option="${slugs[1]}"]`)
    await page.keyboard.press("Escape")
    await closed()

    // The row picks: the chip follows, and the choice is remembered.
    await openMenu()
    await page.click(`[data-console-project-option="${other}"]`)
    await page.waitForSelector(`${CHIP}[data-console-project-chip="${other}"]`)
    await closed()
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), PICK_KEY), other)

    // The dialog has no status row: the chip stands on its title's line, over the box, on the same pick.
    await page.evaluate(async () => {
      const store = "/src/store.ts"
      const { openNewThread } = await import(/* @vite-ignore */ store)
      openNewThread()
    })
    await page.waitForSelector(`[role="dialog"] ${CHIP}[data-console-project-chip="${other}"]`)
    const dialog = await page.evaluate((chip) => {
      const box = document.querySelector('[role="dialog"] [data-composer-box]')!
      return {
        inBox: box.querySelector(chip) !== null,
        above: document.querySelector(`[role="dialog"] ${chip}`)!.getBoundingClientRect().bottom <= box.getBoundingClientRect().top,
      }
    }, CHIP)
    assert.deepEqual(dialog, { inBox: false, above: true })

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
