import assert from "node:assert/strict"
import test from "node:test"

// THE HOME GRID REORDERS BY DRAG (ProjectGrid.tsx useTileReorder), the rail's drag on a grid: a tile held and
// moved slides the tiles it passes aside, wrapping between rows, the drop is the grid's new order at once,
// the server keeps it across a reload, and the click the browser fires on release does not open a project.
// Alt+← on a focused tile moves it one place. And the RAIL's drop lands in one frame: its passed squares
// kept their transition at the drop until 2026-11-12, so each jumped a slot past its new place and slid back.
//
// Only a real browser shows any of it: pointer capture, the release click, and cells measured where the
// grid actually laid them out. Real server, four projects or more, nothing dispatched:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<repo a> --also-project=<repo b> --also-project=<repo c> --also-project=<repo d>
//   FRIZZ_GRID_REORDER_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// The order and the rail setting are put back as they were found.
const baseUrl = process.env.FRIZZ_GRID_REORDER_E2E_URL

type Project = { id: string; slug: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("a project tile dragged across rows stays there, across a reload, without opening a project", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const list = async () => ((await api.query("projectsList")) as Project[]).map((p) => p.slug)
  const original = (await api.query("projectsList")) as Project[]
  assert.ok(original.length >= 4, "the stack has four projects or more, so the grid wraps at 720px")
  const waitForServerOrder = async (want: string[]) => {
    let got: string[] = []
    for (let i = 0; i < 40; i++) {
      got = await list()
      if (got.join() === want.join()) return
      await sleep(100)
    }
    assert.deepEqual(got, want, "the server holds the grid's new order")
  }

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    // 720px: five tracks, so "Add a project", "All projects" and three projects fill the first row and the
    // rest wrap. (701px and under is the phone's list.)
    await page.setViewport({ width: 720, height: 900, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-home-tile]", { timeout: 20_000 })
    const order = () => page.$$eval("[data-home-tile]", (tiles) => tiles.map((t) => t.getAttribute("data-home-tile") ?? ""))
    const squares = () =>
      page.$$eval("[data-home-tile] [data-home-tile-square]", (els) =>
        els.map((el) => {
          const box = el.getBoundingClientRect()
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        }),
      )
    const before = await order()
    assert.deepEqual(before, original.map((p) => p.slug), "the grid draws the server's order")

    // THE DRAG: the first project onto the last one's cell, on another row.
    const cells = await squares()
    const from = cells[0]!
    const to = cells[cells.length - 1]!
    assert.ok(to.y > from.y + 50, "the last tile is on a later row")
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 16; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16)
      await sleep(20)
    }
    await sleep(250)
    const mid = await page.$$eval("[data-home-tile]", (tiles) =>
      tiles.map((t) => ({ held: (t as HTMLElement).dataset.homeTileHeld === "true", transform: (t as HTMLElement).style.transform })),
    )
    assert.ok(mid[0]!.held, "the dragged tile is held")
    assert.ok(mid.slice(1).every((t) => t.transform !== ""), "every tile it passed slid aside")
    // The one that wraps: the first tile of the last row moves UP to the end of the row above.
    assert.match(mid.at(-1)!.transform, /translate\(\d+px, -\d+px\)/, "the passed tile at a row's start wraps to the row above")
    assert.equal(await page.$('[role="tooltip"]'), null, "no tooltip rides along with the held tile")
    await page.mouse.up()
    const dropped = [...before.slice(1), before[0]!]
    await page.waitForFunction((want) => [...document.querySelectorAll("[data-home-tile]")].map((t) => t.getAttribute("data-home-tile")).join() === want, { timeout: 5_000 }, dropped.join())
    await sleep(300)
    assert.equal(new URL(page.url()).pathname, "/", "the release did not open a project")
    assert.deepEqual(
      await page.$$eval("[data-home-tile]", (tiles) => tiles.map((t) => (t as HTMLElement).style.transform).filter(Boolean)),
      [],
      "no tile is left offset after the drop",
    )
    await waitForServerOrder(dropped)

    // A press that wanders and comes back changes nothing and opens nothing.
    const back = (await squares())[1]!
    await page.mouse.move(back.x, back.y)
    await page.mouse.down()
    await page.mouse.move(back.x + 30, back.y + 10, { steps: 5 })
    await page.mouse.move(back.x, back.y, { steps: 5 })
    await page.mouse.up()
    await sleep(600)
    assert.deepEqual(await order(), dropped, "a drag dropped where it began changes nothing")
    assert.equal(new URL(page.url()).pathname, "/", "…and opens nothing")

    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector("[data-home-tile]")
    assert.deepEqual(await order(), dropped, "the order survives a reload")

    // THE KEYBOARD: Alt+← on the last tile's name moves it one place earlier, and focus goes with it.
    const last = dropped.at(-1)!
    await page.focus(`[data-home-tile="${last}"] [data-home-tile-name]`)
    await page.keyboard.down("Alt")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.up("Alt")
    const keyed = [...dropped.slice(0, -2), dropped.at(-1)!, dropped.at(-2)!]
    await page.waitForFunction((want) => [...document.querySelectorAll("[data-home-tile]")].map((t) => t.getAttribute("data-home-tile")).join() === want, { timeout: 5_000 }, keyed.join())
    await sleep(100)
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest("[data-home-tile]")?.getAttribute("data-home-tile")),
      last,
      "focus followed the moved tile",
    )
    await waitForServerOrder(keyed)

    // A plain click still opens the project.
    const first = (await squares())[0]!
    await page.mouse.click(first.x, first.y)
    await page.waitForFunction((want) => location.pathname === want, { timeout: 10_000 }, `/project/${keyed[0]}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    await api.mutate("projectsReorder", { ids: original.map((p) => p.id) })
  }
})

test("a rail drop lands in one frame: the squares it passed do not slide back in from a slot away", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const original = (await api.query("projectsList")) as Project[]
  const settings = (await api.query("settingsGet")) as Record<string, unknown>
  await api.mutate("settingsSet", { ...settings, projectRail: true })
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    await page.goto(`${baseUrl}/project/${original[0]!.slug}`, { waitUntil: "networkidle2" })
    const rail = 'nav[aria-label="Projects"] .frizz-rail-scroll a'
    await page.waitForSelector(rail, { timeout: 20_000 })
    await sleep(500)
    const squares = await page.$$eval(rail, (links) => links.map((a) => { const box = a.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: Math.round(box.top) } }))
    const slotTops = squares.map((s) => s.top)
    await page.mouse.move(squares[0]!.x, squares[0]!.y)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(squares[0]!.x, squares[0]!.y + ((squares[2]!.y - squares[0]!.y) * i) / 12)
      await sleep(20)
    }
    await sleep(300)
    // Every square's painted top, on every frame from just before the release until well after it.
    await page.evaluate((selector) => {
      const frames: number[][] = []
      ;(window as unknown as { __railFrames: number[][] }).__railFrames = frames
      const t0 = performance.now()
      const sample = () => {
        frames.push([...document.querySelectorAll(selector)].map((a) => Math.round(a.getBoundingClientRect().top)))
        if (performance.now() - t0 < 500) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, rail)
    await sleep(50)
    await page.mouse.up()
    await sleep(600)
    const frames = await page.evaluate(() => (window as unknown as { __railFrames: number[][] }).__railFrames)
    const strays = frames.flat().filter((top) => !slotTops.includes(top))
    assert.deepEqual(strays, [], "no square is ever painted between slots across the drop")
  } finally {
    await browser.close()
    await api.mutate("projectsReorder", { ids: original.map((p) => p.id) })
    await api.mutate("settingsSet", settings)
  }
})
