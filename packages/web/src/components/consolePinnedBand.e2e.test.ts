import assert from "node:assert/strict"
import test from "node:test"

// THE CONSOLE'S OWN PIN SHELF (ConsoleSidebar.tsx, lib/consoleBoard.ts PINS). On All projects' "By status"
// view a row's hover pin writes the CONSOLE's shelf, never the project board's: the pinned threads leave
// Queue and Running for a Pinned band at the top, in the shelf's order, and a project board's own pin plays
// no part there. The queue the one-thread pane steps through (ThreadPane.tsx usePaneQueue, lib/consoleBoard
// consoleCardOrder) takes the band's order too: the pinned threads waiting on you come first, as the band
// stands above Queue, so `j` walks the sidebar top to bottom. (Until 2026-11-09 that order was the queue
// cards'. The pinned threads here end on a question, since a pinned plain report leaves the queue
// altogether: pinnedReports.e2e.test.ts.) The band spans projects, so a drop is written by the
// browser — one write when the moved row has room between its new neighbours, and one call per project
// touched when it has not — and the band must never show an order that is neither the old nor the new
// while those calls land one project at a time.
//
// Real server, two projects, the scripted worker (nothing signs in):
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<throwaway repo> --also-project=<another> \
//     --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_CONSOLE_PINS_E2E_URL=http://127.0.0.1:<port> FRIZZ_CONSOLE_PINS_E2E_PROJECTS=<launcher id>,<tenant id> \
//     nub run test <this file>
// The ids are the stack's json line's `launcher.id` and `tenants[0].id`. The test dispatches six threads,
// one of them holding a tool call for 15 minutes; kill the stack's workers with the stack.
const baseUrl = process.env.FRIZZ_CONSOLE_PINS_E2E_URL
const projectIds = (process.env.FRIZZ_CONSOLE_PINS_E2E_PROJECTS ?? "").split(",").filter(Boolean)

type BoardThread = { id: string; sessionId?: string; runtime: string; pinnedAt?: string; consolePinnedAt?: string }
type Board = { projectSlug: string; threads: BoardThread[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("the Console's By status view pins, orders and drags a shelf of its own", { skip: !baseUrl || projectIds.length !== 2, timeout: 480_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const [alpha, beta] = projectIds.map((id) => createRpcClient(`${baseUrl}/`, id))
  await alpha!.waitForHealth()
  const board = (api: typeof alpha) => api!.query("board") as Promise<Board>
  const dispatch = async (api: typeof alpha, title: string, script: string) =>
    ((await api!.mutate("dispatch", { prompt: `[script ${script}] ${title}`, title, backend: "claude", model: "haiku", effort: "low" })) as { slug: string }).slug
  const A1 = await dispatch(alpha, "Console pins alpha one", "ending=needs paras=1")
  const A2 = await dispatch(alpha, "Console pins alpha two", "ending=question paras=1")
  const A3 = await dispatch(alpha, "Console pins alpha three, running", "ending=needs paras=1 tools=1 toolms=900000")
  const B1 = await dispatch(beta, "Console pins beta one", "ending=question paras=1")
  const B2 = await dispatch(beta, "Console pins beta two", "ending=question paras=1")
  const B3 = await dispatch(beta, "Console pins beta three, pinned on its board", "ending=needs paras=1")
  let slugs = { alpha: "", beta: "" }
  for (let i = 0; i < 200; i++) {
    const [a, b] = [await board(alpha), await board(beta)]
    const rt = (bd: Board, s: string) => bd.threads.find((t) => t.id === s)?.runtime
    if ([A1, A2].every((s) => rt(a, s) === "turn-idle") && rt(a, A3) === "running" && [B1, B2, B3].every((s) => rt(b, s) === "turn-idle")) {
      slugs = { alpha: a.projectSlug, beta: b.projectSlug }
      break
    }
    await sleep(250)
  }
  assert.ok(slugs.alpha && slugs.beta, "the scripted threads settled")
  const session = async (api: typeof alpha, slug: string) => (await board(api)).threads.find((t) => t.id === slug)?.sessionId ?? ""
  // A stack that has run this (or the board's own pin tests) before still holds pins: both shelves are
  // this run's alone.
  for (const api of [alpha, beta]) {
    for (const t of (await board(api)).threads) {
      const sessionId = t.sessionId ?? ""
      if (typeof t.consolePinnedAt === "string") await api!.mutate("setThreadConsolePinned", { slug: t.id, sessionId, pinned: false })
      if (typeof t.pinnedAt === "string") await api!.mutate("setThreadPinned", { slug: t.id, sessionId, pinned: false })
    }
  }
  // B3 is pinned on its PROJECT board, which the By status view must neither lift nor mark.
  await beta!.mutate("setThreadPinned", { slug: B3, sessionId: await session(beta, B3), pinned: true })
  const [kA1, kA2, kA3] = [A1, A2, A3].map((s) => `${slugs.alpha}~${s}`)
  const [kB1, kB2, kB3] = [B1, B2, B3].map((s) => `${slugs.beta}~${s}`)
  // The servers' shelf, as the Console sorts it: by instant, then key.
  const serverShelf = async () => {
    const all = [
      ...(await board(alpha)).threads.map((t) => ({ ...t, id: `${slugs.alpha}~${t.id}` })),
      ...(await board(beta)).threads.map((t) => ({ ...t, id: `${slugs.beta}~${t.id}` })),
    ]
    return all
      .filter((t) => typeof t.consolePinnedAt === "string")
      .sort((x, y) => x.consolePinnedAt!.localeCompare(y.consolePinnedAt!) || x.id.localeCompare(y.id))
  }
  const waitForServer = async (want: string[], label: string) => {
    let got: string[] = []
    for (let i = 0; i < 50; i++) {
      got = (await serverShelf()).map((t) => t.id)
      if (got.join() === want.join()) return
      await sleep(100)
    }
    assert.deepEqual(got, want, label)
  }

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    const reorderCalls: string[] = []
    page.on("request", (r) => { if (/\/rpc\/reorderConsolePinnedThreads\b/.test(r.url())) reorderCalls.push(new URL(r.url()).pathname.split("/")[2]!) })
    await page.evaluateOnNewDocument(() => localStorage.setItem("frizz:console-group", "status"))
    const rail = "[data-console-sidebar] [data-sidebar-rail]"
    // The running A3 rows in the Running band, which every load starts collapsed (2026-11-11).
    const openRunning = async () => {
      await page.waitForSelector(`${rail} [data-band-header="running"]`, { timeout: 20_000 })
      const folded = await page.$(`${rail} [data-band-header="running"][aria-expanded="false"]`)
      if (folded) await folded.click()
    }
    await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await openRunning()
    await page.waitForSelector(`[data-sidebar-item="${kA3}"]`, { timeout: 20_000 })
    await page.waitForSelector(`[data-sidebar-item="${kB3}"]`, { timeout: 20_000 })

    const pinnedIds = () => page.$$eval(`${rail} [data-console-pinned] [data-pinned-row]`, (rows) => rows.map((r) => r.getAttribute("data-pinned-row")))
    const outsidePinned = () =>
      page.$$eval(`${rail} [data-sidebar-item]`, (rows) => rows.filter((r) => !r.closest("[data-console-pinned]")).map((r) => r.getAttribute("data-sidebar-item")))
    // THE PANE'S QUEUE, read the way a reader walks it: a fresh load of the Console, its pane empty, then
    // `j` until it stops moving. Every step opens a thread, which reads it and dequeues nothing. The walk
    // ends on a fresh load again, the pane empty.
    const consoleUrl = `${baseUrl}/console`
    const paneSlug = () => page.evaluate(() => document.querySelector("[data-pane-thread] [data-thread-surface]")?.getAttribute("data-thread-surface") ?? null)
    const queueIds = async () => {
      await page.goto(consoleUrl, { waitUntil: "networkidle2" })
      await page.waitForSelector("[data-pane-empty]", { timeout: 20_000 })
      await page.waitForSelector(`[data-sidebar-item="${kB3}"]`, { timeout: 20_000 })
      // As many steps as the empty pane says are waiting, so the walk never waits out a step past the end.
      const waiting = await page.$eval("[data-pane-empty]", (el) => Number(/(\d+) threads? (?:is|are) waiting/.exec(el.textContent ?? "")?.[1] ?? 0))
      const steps: string[] = []
      for (let i = 0; i < waiting; i++) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.keyboard.press("j")
        // A thread of another project draws once its transcript is in, which takes seconds on a loaded Mac.
        let now: string | null = null
        for (let w = 0; w < 100; w++) {
          now = await paneSlug()
          if (now !== null && now !== steps.at(-1)) break
          await sleep(100)
        }
        if (now === null || now === steps.at(-1)) break
        steps.push(now)
      }
      await page.goto(consoleUrl, { waitUntil: "networkidle2" })
      await page.waitForSelector(`[data-sidebar-item="${kB3}"]`, { timeout: 20_000 })
      await openRunning()
      return steps
    }
    // A pinned row shows its pin only on hover, as the unpin verb (2026-10-24), so "pinned on the shelf
    // this view speaks for" reads off that verb rather than a resting mark.
    const offersUnpin = async (id: string) => {
      await page.hover(`[data-sidebar-item="${id}"]`)
      const label = await page.$eval(`[data-sidebar-item="${id}"] [data-sidebar-pin]`, (el) => el.getAttribute("aria-label") ?? "")
      await page.mouse.move(5, 5)
      return label.startsWith("Unpin")
    }
    const hasAge = (id: string) => page.$eval(`[data-sidebar-item="${id}"]`, (el) => el.querySelector("[data-rail-rested-age]") !== null)
    // The grouping is a chip that opens a menu (RailViewChips.tsx): open it, then pick.
    const pickGroup = async (group: "status" | "project") => {
      await page.click(`${rail} [data-rail-view-chip="group"]`)
      await page.waitForSelector(`[data-rail-view-option="${group}"]`)
      await page.click(`[data-rail-view-option="${group}"]`)
    }
    const pinVerb = async (id: string) => {
      await page.hover(`[data-sidebar-item="${id}"]`)
      await page.click(`[data-sidebar-item="${id}"] [data-sidebar-pin][data-pin-shelf="console"]`)
      await page.mouse.move(5, 5)
    }
    const waitPinned = async (want: string[], label: string) => {
      let got: (string | null)[] = []
      for (let i = 0; i < 60; i++) {
        got = await pinnedIds()
        if (got.join() === want.join()) return
        await sleep(100)
      }
      assert.deepEqual(got, want, label)
    }
    const waitQueue = async (lead: string[], label: string) => {
      let got: string[] = []
      for (let i = 0; i < 8; i++) {
        got = await queueIds()
        if (got.slice(0, lead.length).join() === lead.join()) return got
        await sleep(500)
      }
      assert.deepEqual(got.slice(0, lead.length), lead, label)
      return got
    }
    const box = (id: string) =>
      page.$eval(`[data-pinned-row="${id}"]`, (el) => {
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, top: r.top, height: r.height }
      })
    // The band is at the rail's top, but a hover on a row further down (step 2's running row, on a stack
    // that has queued many threads) scrolls the rail, and a band scrolled past its top edge has nothing
    // under the pointer to drag. Bring it back first; `toY` is read after this.
    const showBand = () => page.$eval(rail, (el) => { el.scrollTop = 0 })
    const drag = async (id: string, toY: number) => {
      const from = await box(id)
      const startY = from.top + from.height / 2
      await page.mouse.move(from.x, startY)
      await page.mouse.down()
      const step = toY < startY ? -6 : 6
      for (let y = startY; step < 0 ? y > toY : y < toY; y += step) await page.mouse.move(from.x, y)
      await page.mouse.move(from.x, toY)
      await sleep(250)
      await page.mouse.up()
    }

    // 1. A BOARD PIN plays no part in By status: no band, and B3 keeps its rest time in Queue.
    assert.equal(await page.$(`${rail} [data-console-pinned]`), null)
    assert.equal(await offersUnpin(kB3), false, "a board pin offers no unpin here")
    assert.equal(await hasAge(kB3), true)
    const queueBefore = await queueIds()
    for (const id of [kA1, kA2, kB1, kB2, kB3]) assert.ok(queueBefore.includes(id), `${id}, at rest, is in the queue`)

    // 2. PIN from the hover verb: two waiting threads of two projects and a running one.
    await pinVerb(kA2)
    await waitPinned([kA2], "A2 pinned")
    await pinVerb(kB1)
    await waitPinned([kA2, kB1], "B1 lands below A2")
    await pinVerb(kA3)
    await waitPinned([kA2, kB1, kA3], "the running A3 is pinned too")
    const outside = await outsidePinned()
    for (const id of [kA2, kB1, kA3]) {
      assert.ok(!outside.includes(id), `${id} left Queue and Running`)
      assert.equal(await offersUnpin(id), true, `${id} offers its unpin`)
    }
    for (const id of [kA1, kB2, kB3]) assert.ok(outside.includes(id), `${id} stays in Queue`)
    const queue = await waitQueue([kA2, kB1], "the pinned threads lead the pane's queue, in the band's order")
    assert.deepEqual(queue.slice(2), queueBefore.filter((id) => id !== kA2 && id !== kB1), "the rest keep the queue's order")
    const a2 = (await board(alpha)).threads.find((t) => t.id === A2)!
    assert.equal(typeof a2.consolePinnedAt, "string")
    assert.equal(a2.pinnedAt, undefined, "a Console pin is not a board pin")
    assert.equal((await board(beta)).threads.find((t) => t.id === B3)!.consolePinnedAt, undefined, "nor the other way round")

    // 3. DRAG A3 to the top, past rows of both projects: one write, to alpha alone.
    reorderCalls.length = 0
    await showBand()
    await drag(kA3, (await box(kA2)).top + 4)
    assert.deepEqual(await pinnedIds(), [kA3, kA2, kB1], "the drop is the band's order at once")
    await waitForServer([kA3, kA2, kB1], "the servers hold it")
    assert.deepEqual(reorderCalls, [slugs.alpha], "one call, to the moved row's project")

    // 4. A TIE leaves no room, so the shelf is dealt again across BOTH projects — and the band shows the
    //    new order at once and never an in-between one while the two writes land. Four rows, because
    //    with three every drop is also a single move that has room.
    await beta!.mutate("setThreadConsolePinned", { slug: B2, sessionId: await session(beta, B2), pinned: true })
    await alpha!.mutate("reorderConsolePinnedThreads", { pins: [{ slug: A3, at: "2026-10-01T00:00:00.000Z" }, { slug: A2, at: "2026-10-01T01:00:00.000Z" }] })
    await beta!.mutate("reorderConsolePinnedThreads", { pins: [{ slug: B1, at: "2026-10-01T00:00:00.000Z" }, { slug: B2, at: "2026-10-01T02:00:00.000Z" }] })
    await waitPinned([kA3, kB1, kA2, kB2], "A3 and B1 tied, broken on the key")
    await page.evaluate(() => {
      const w = window as unknown as { __orders: string[] }
      w.__orders = []
      const band = document.querySelector("[data-console-pinned] [data-pinned-band]")!
      new MutationObserver(() => w.__orders.push([...band.querySelectorAll(":scope > [data-pinned-row]")].map((r) => r.getAttribute("data-pinned-row")).join())).observe(band, { childList: true })
    })
    reorderCalls.length = 0
    await showBand()
    await drag(kB2, (await box(kB1)).top + 4)
    const want = [kA3, kB2, kB1, kA2]
    assert.deepEqual(await pinnedIds(), want, "the drop is the band's order at once")
    await waitForServer(want, "both projects hold it")
    await sleep(800)
    assert.deepEqual(await pinnedIds(), want, "…and the band still reads it once both boards carry it back")
    assert.deepEqual([...reorderCalls].sort(), [slugs.alpha, slugs.beta].sort(), "one call per project the deal touched")
    const instants = (await serverShelf()).map((t) => t.consolePinnedAt!)
    assert.ok(instants.every((v, i) => i === 0 || v > instants[i - 1]!), `no tie is left: ${instants.join(" ")}`)
    const seen = await page.evaluate(() => (window as unknown as { __orders: string[] }).__orders)
    assert.ok(seen.length > 0, "the observer saw the drop")
    for (const order of seen) assert.ok([[kA3, kB1, kA2, kB2].join(), want.join()].includes(order), `an in-between order flashed: ${order}`)

    // 5. A RELOAD reads the servers' order, and the pane's queue follows it (A3 is running: not queued).
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector(`${rail} [data-console-pinned] [data-pinned-row="${kB1}"]`, { timeout: 20_000 })
    assert.deepEqual(await pinnedIds(), want, "the order survived a reload")
    await waitQueue([kB2, kB1, kA2], "the pane's queue follows the shelf")

    // 6. BY PROJECT wears each board's pins and no Console band.
    await pickGroup("project")
    await page.waitForSelector("[data-console-project-header]")
    assert.equal(await page.$(`${rail} [data-console-pinned]`), null)
    assert.equal(await offersUnpin(kA2), false, "a Console pin offers no unpin By project")
    assert.equal(await offersUnpin(kB3), true, "a board pin does")
    assert.equal(await hasAge(kB3), true, "and its row keeps its rest time: the pin shows only on hover")
    await page.hover(`[data-sidebar-item="${kA1}"]`)
    assert.ok(await page.$(`[data-sidebar-item="${kA1}"] [data-sidebar-pin][data-pin-shelf="board"]`), "and its pin verb is the board's")
    await page.mouse.move(5, 5)
    await pickGroup("status")
    await page.waitForSelector(`${rail} [data-console-pinned]`)

    // 7. UNPIN from the band: B1 goes back to Queue with its rest time.
    await pinVerb(kB1)
    await waitPinned([kA3, kB2, kA2], "B1 unpinned")
    assert.ok((await outsidePinned()).includes(kB1))
    assert.equal(await hasAge(kB1), true)

    // 8. THE BOARDS keep their own shelves: alpha's has nothing, beta's only B3.
    await page.goto(`${baseUrl}/project/${slugs.alpha}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`[data-sidebar-item="${A1}"]`, { timeout: 20_000 })
    assert.equal(await page.$("[data-pinned-band]"), null, "alpha's board shows no pins")
    await page.goto(`${baseUrl}/project/${slugs.beta}`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-pinned-band]", { timeout: 20_000 })
    assert.deepEqual(await page.$$eval("[data-pinned-band] > [data-pinned-row]", (rows) => rows.map((r) => r.getAttribute("data-pinned-row"))), [B3])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
