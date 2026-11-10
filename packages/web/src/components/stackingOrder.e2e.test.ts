import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// THE STACKING ORDER IN A REAL BROWSER (lib/layers.ts). Its guard test holds the source to the rules;
// this asks the browser what is actually on top, and what actually takes Escape, a keystroke and a tap,
// for each bug the 2026-11-01 audit found on main (a desktop drawer, which a board then opened, now
// opens over a status list; see openDrawer):
//   · Settings opened from ⌘K over a thread drawer slid in UNDER it, on the desktop and the phone;
//   · Escape with ⌘K or Settings over a drawer closed the DRAWER and left the overlay up, and on the
//     phone ⌘K over a drawer took no keystroke at all (rule 4: a layer outside Radix's stack loses);
//   · a toast fired from inside the sign-in modal was painted under the modal's scrim;
//   · the project rail stayed lit and clickable through the Settings scrim;
//   · the drawer's "Jump to latest" pill painted across the composer's skills menu;
//   · on the phone board a toast sat on the "New thread" button and its Undo took the tap.
//
// Point at the BOARD URL of an isolated adhoc-stack seeded with board threads (its snoozed-0 is the
// drawer), never the live instance:
//   nub scripts/adhoc-stack.mjs --port=47393 --also-project=/abs/throwaway-repo > stack.log 2>&1
//   nub scripts/seed-console-bands.mjs --home=<home> --project=<launcher.id>=<launcher.dir> \
//     --project=<tenants[0].id>=<tenants[0].dir> --done=2,2
//   FRIZZ_STACKING_E2E_URL=<url from stack.log> nub run test packages/web/src/components/stackingOrder.e2e.test.ts
// Nothing here can start a worker: the sign-in modal is opened by the `/login` alias, which dispatches
// nothing, and the credential check behind its Retry is answered "signed out" in the browser. The skills
// list is answered there too, since a simulated thread has no live session to list them. The rail
// setting is put back as it was found.
const url = process.env.FRIZZ_STACKING_E2E_URL?.replace(/\/$/, "")

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
before(async () => {
  if (!url) return
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless({ protocolTimeout: 60_000 })
})
after(async () => {
  await browser?.close()
})

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Points across `selector`'s box where something OTHER than it is the topmost element, by PAINT order:
 * every element is made hittable while the points are read, since `elementFromPoint` skips anything
 * click-through (the toast strip is, by design) and would report it covered when it is on top.
 */
function coveredPoints(selector: string) {
  const el = document.querySelector(selector)
  if (!el) return { covered: -1, by: [`missing ${selector}`] }
  const force = document.createElement("style")
  force.textContent = "*, *::before, *::after { pointer-events: auto !important }"
  document.head.append(force)
  try {
    // Its own wrapper shows past its rounded corners; that is the element, not something over it.
    const own = el.parentElement ?? el
    const r = el.getBoundingClientRect()
    const by: string[] = []
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 6; j++) {
        const hit = document.elementFromPoint(r.left + 3 + ((r.width - 6) * i) / 11, r.top + 3 + ((r.height - 6) * j) / 5)
        if (hit && !own.contains(hit)) by.push(`${hit.tagName.toLowerCase()}.${String(hit.className).split(" ").slice(0, 3).join(".")}`)
      }
    }
    return { covered: by.length, by: [...new Set(by)] }
  } finally {
    force.remove()
  }
}

async function open(viewport: "desktop" | "phone", height = 900, width = viewport === "phone" ? 700 : 1440): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage()
  page.setDefaultTimeout(20_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  await page.setRequestInterception(true)
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith("/rpc/threadSkills")) {
      const skills = Array.from({ length: 9 }, (_, i) => ({ name: `skill-${i}`, description: `What skill ${i} does, in one line` }))
      return void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { skills } }) })
    }
    if (path.endsWith("/rpc/authStatus")) {
      const result = { claude: "signed-out", codex: "signed-out", emails: {} }
      return void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) })
    }
    return void request.continue()
  })
  if (viewport === "phone") await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  else await page.setViewport({ width, height, deviceScaleFactor: 1 })
  return { page, errors }
}

// A thread's drawer. On the phone a board link opens one (MobileBoard). A desktop board opens every
// thread in its one-thread pane instead (since 2026-11-09), so there the drawer is opened over a status
// list, the one board view with no pane (store.paneEnabled).
async function openDrawer(page: Page, viewport: "desktop" | "phone"): Promise<void> {
  const over = viewport === "desktop" ? `${url}/status/active` : url
  await page.goto(`${over}?thread=snoozed-0`, { waitUntil: "networkidle2" })
  await page.waitForSelector(".frizz-sheet-panel")
  await settle(500)
}

const drawerOpen = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /^Thread:/.test(d.querySelector("h2")?.textContent ?? "")))

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.down("Meta")
  await page.keyboard.press("k")
  await page.keyboard.up("Meta")
  await page.waitForSelector('[aria-label="Command palette"] input')
  // Focus, not just presence: over a modal phone drawer the input drew and took no keystroke.
  await page.waitForFunction(() => document.activeElement === document.querySelector('[aria-label="Command palette"] input'), { timeout: 5_000 })
    .catch(() => assert.fail("the palette's input never took focus"))
}

async function overlaysOverADrawer(viewport: "desktop" | "phone"): Promise<void> {
  const { page, errors } = await open(viewport)
  try {
    await openDrawer(page, viewport)

    await openPalette(page)
    await page.keyboard.type("settings")
    assert.equal(await page.$eval('[aria-label="Command palette"] input', (input) => (input as HTMLInputElement).value), "settings")
    await page.keyboard.press("Escape")
    await page.waitForSelector('[aria-label="Command palette"]', { hidden: true, timeout: 5_000 })
    assert.equal(await drawerOpen(page), true, "Escape closed the palette, and only the palette")

    await openPalette(page)
    await page.keyboard.type("settings")
    await page.keyboard.press("Enter")
    const settings = viewport === "phone" ? "[data-mobile-settings-page]" : "[data-settings-panel]"
    await page.waitForSelector(settings)
    // Slid fully in: its right edge on the window's.
    await page.waitForFunction((sel) => Math.abs(document.querySelector(sel)!.getBoundingClientRect().right - document.documentElement.clientWidth) < 1, {}, settings)
    assert.deepEqual(await page.evaluate(coveredPoints, settings), { covered: 0, by: [] }, "Settings is drawn over the drawer")
    await page.keyboard.press("Escape")
    await page.waitForSelector(settings, { hidden: true, timeout: 5_000 })
    assert.equal(await drawerOpen(page), true, "Escape closed Settings, and only Settings")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}

test("⌘K and Settings opened over a thread drawer are the top layer: drawn over it, typed into, and the ones Escape closes", { skip: !url, timeout: 120_000 }, () =>
  overlaysOverADrawer("desktop"))

test("the same on the phone, where the drawer is a modal layer", { skip: !url, timeout: 120_000 }, () =>
  overlaysOverADrawer("phone"))

test("a toast fired from inside the sign-in modal is drawn over it", { skip: !url, timeout: 120_000 }, async () => {
  const { page, errors } = await open("desktop")
  try {
    await page.goto(url!, { waitUntil: "networkidle2" })
    const box = await page.waitForSelector("aside textarea")
    await box!.click()
    await page.keyboard.type("/login")
    await page.keyboard.press("Enter")
    const retry = await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => /^retry$/i.test(button.textContent?.trim() ?? "")))
    await (retry as unknown as { click: () => Promise<void> }).click()
    await page.waitForFunction(() => /still signed out/i.test(document.querySelector("[data-toast]")?.textContent ?? ""))
    await settle(400)
    assert.deepEqual(await page.evaluate(coveredPoints, "[data-toast]"), { covered: 0, by: [] }, "the toast is drawn over the modal and its scrim")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("the project rail sits under the Settings scrim", { skip: !url, timeout: 120_000 }, async () => {
  const origin = new URL(url!).origin
  const rpc = `${origin}/_frizz/rpc`
  const headers = { origin, "content-type": "application/json" }
  const found = ((await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }).result
  const set = (projectRail: unknown) => fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...found, projectRail }) })
  assert.equal((await set(true)).status, 200)
  const { page, errors } = await open("desktop")
  try {
    await page.goto(url!, { waitUntil: "networkidle2" })
    await page.waitForSelector('nav[aria-label="Projects"]')
    await page.click('[data-status-row] button[aria-label="Settings"]')
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]')
    await settle(500)
    const top = await page.evaluate(() => {
      const rail = document.querySelector('nav[aria-label="Projects"]')!.getBoundingClientRect()
      return document.elementFromPoint(rail.left + rail.width / 2, rail.top + rail.height / 2)?.closest('nav[aria-label="Projects"]') !== null
    })
    assert.equal(top, false, "the scrim covers the rail")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
    await set(found.projectRail)
  }
})

test("the composer's skills menu is drawn over the drawer's jump-to-latest pill", { skip: !url, timeout: 120_000 }, async () => {
  // A short window, so the drawer's transcript scrolls and its pill shows: bottom-right over the
  // transcript, where the menu opens above the composer. And a phone's width, the one layout where the
  // two still meet: the menu takes 70% of the prompt box from its left edge, 340px at the least
  // (lib/overlaySurface.ts `panelWidthOn`, since 2026-11-06), and the pill hugs the right edge. A
  // desktop drawer is never narrower than 80% of a 701px window, which leaves the pill clear of the menu
  // (at 1440x420 the menu ended at x 1220 and the pill began at 1303). At 390px the 340px floor reaches
  // well past the pill's left edge.
  const { page, errors } = await open("phone", 420, 390)
  try {
    await openDrawer(page, "phone")
    // A READER's scroll (a wheel): the transcript snaps a programmatic one back to its tail.
    const middle = await page.evaluate(() => {
      const scroller = [...document.querySelectorAll(".frizz-sheet-panel *")].find((el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY))!
      const r = scroller.getBoundingClientRect()
      return [r.left + r.width / 2, r.top + r.height / 2] as const
    })
    await page.mouse.move(middle[0], middle[1])
    await page.mouse.wheel({ deltaY: -600 })
    await page.waitForSelector("[data-jump-to-latest]")
    await (await page.waitForSelector(".frizz-sheet-panel textarea"))!.click()
    await page.keyboard.type("/")
    await page.waitForSelector("[data-slash-menu]")
    await settle(300)
    const overlap = await page.evaluate(() => {
      const a = document.querySelector("[data-slash-menu]")!.getBoundingClientRect()
      const b = document.querySelector("[data-jump-to-latest]")!.getBoundingClientRect()
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    })
    assert.ok(overlap > 0, "the pill sits under the menu's box, or this proves nothing")
    assert.deepEqual(await page.evaluate(coveredPoints, "[data-slash-menu]"), { covered: 0, by: [] }, "nothing paints over the menu")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test("on the phone board a toast rides above the New thread button", { skip: !url, timeout: 120_000 }, async () => {
  const { page, errors } = await open("phone")
  try {
    await page.goto(url!, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-mobile-new-thread]")
    // A toast with an action, as the thread page's Done raises ("… marked done [Undo]").
    await page.evaluate(async () => {
      const { showToast } = await import("/src/store.ts" as string)
      showToast("“A thread” marked done", { sticky: true, action: { label: "Undo", run: () => {} } })
    })
    await page.waitForSelector("[data-toast]")
    await settle(400)
    const overlap = await page.evaluate(() => {
      const a = document.querySelector("[data-toast]")!.getBoundingClientRect()
      const b = document.querySelector("[data-mobile-new-thread]")!.getBoundingClientRect()
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    })
    assert.equal(overlap, 0, "the toast clears the button")
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
