import assert from "node:assert/strict"
import test from "node:test"

// THE RAIL HOLDS STILL WHILE THE HUMAN ACTS ON THE QUEUE. Runtime coverage for the two ways it did not,
// both recorded frame by frame on 2026-10-13 against a stack whose worker is the scripted Claude:
//
//   1. A send from a queue card moved the scroll marker THREE times in ~250ms: onto the sent row in the
//      Running band for 2-3 frames (27 of 27 recordings), onto the card ABOVE for the length of the fade,
//      then onto the card below. It now moves once, to the row that takes the sent row's place, in the
//      commit that moves the row (lib/sidebarScrollspy markerRow).
//   2. A dispatch from the prompt box mounted a "Starting thread…" card between the box and the rail for
//      the length of the dispatch call: every row moved down 73px at the click and back up when the call
//      answered (5 of 5). The rail now draws the pending thread as the Running row it becomes
//      (lib/pendingDispatch), so one row appears and nothing else moves.
//
//   3. The Console's prompt box and the first-run one still mounted that card. On the Console every row
//      moved down 93px and back up, in either grouping (3 of 3 each); it draws the Running row now, in
//      the project's own block when the list is grouped by project. On a board with no thread there is
//      no rail to draw a row in, and the form is centred in the window, so the card lifted the heading
//      and the box 36-37px (3 of 3). The card stays there and floats under the form instead.
//
//   4. In the stacked layout (800px and under, the sidebar above the queue) a row arriving in the rail
//      moved every card down by its height whenever any slice of the rail was still on screen, because
//      the browser anchors a scroll position to the first thing on screen and that was the rail. The
//      rail is not an anchor while a queue card is on screen (lib/stackedRailAnchor), so the offset
//      absorbs the row and the cards hold.
//
//   5. A card arriving ABOVE the reader moved them: newest first at the top of the page, where native
//      scroll anchoring never applies, the card being read was pushed a whole card down and the newcomer
//      took its place; and on iOS Safari, which has no scroll anchoring at all, any card landing above
//      did the same. The queue holds the card the reader is in through every arrival itself
//      (lib/readerPin), so both cases are pinned here: the first at scrollY 0, the second with the
//      browser's anchoring switched off.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): `nub run test:e2e -- queueRailSettle.e2e.test.ts`, or start `vite` in packages/web and set
// FRIZZ_QUEUE_RAIL_SETTLE_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_QUEUE_RAIL_SETTLE_E2E_URL

const ABOVE = "auth-refresh"
const SENT = "csv-export"
const BELOW = "flaky-e2e"

test("a send from a queue card hands the scroll marker to the row that takes its place — once, and never into Running", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    // Read the middle card with part of the one above it still on screen — the arrangement in which the
    // marker used to visit the card above while the sent card faded.
    await page.evaluate((sent: string) => {
      const card = document.querySelector<HTMLElement>(`[data-queue-card="${sent}"]`)!
      window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top - 300)
    }, SENT)
    await page.waitForFunction((sent: string) => !!document.querySelector(`[data-sidebar-item="${sent}"] [data-sidebar-scroll-marker]`), { timeout: 5_000 }, SENT)

    const composer = `[data-queue-card="${SENT}"] textarea[placeholder*="reply" i]`
    await page.click(composer)
    await page.type(composer, "Carry on with the second pass.")
    await new Promise((r) => setTimeout(r, 200))

    await page.evaluate(() => {
      const w = window as unknown as { __markerFrames: { t: number; row: string | null; band: string | null }[] }
      w.__markerFrames = []
      const t0 = performance.now()
      const tick = () => {
        const marker = document.querySelector("[data-sidebar-scroll-marker]")
        const row = marker?.closest<HTMLElement>("[data-sidebar-item]") ?? null
        // The band a row sits in is the last label above it in the rail.
        let band: string | null = null
        if (row) {
          for (const el of document.querySelectorAll<HTMLElement>("[data-sidebar-rail] .uppercase, [data-sidebar-rail] [data-sidebar-item]")) {
            if (el === row) break
            if (!el.matches("[data-sidebar-item]")) band = (el.innerText ?? "").trim().split(/\s+/)[0].toLowerCase()
          }
        }
        w.__markerFrames.push({ t: +(performance.now() - t0).toFixed(1), row: row?.dataset.sidebarItem ?? null, band })
        if (performance.now() - t0 < 1200) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.keyboard.press("Enter")
    await page.waitForFunction((sent: string) => !document.querySelector(`[data-queue-card-root="${sent}"]`), { timeout: 5_000 }, SENT)
    await new Promise((r) => setTimeout(r, 900))
    const frames = await page.evaluate(() => (window as unknown as { __markerFrames: { t: number; row: string | null; band: string | null }[] }).__markerFrames)

    assert.ok(frames.length > 20, `expected a full sampling window, got ${frames.length} frames`)
    const path: (string | null)[] = []
    for (const f of frames) if (path.length === 0 || path[path.length - 1] !== f.row) path.push(f.row)
    assert.deepEqual(path, [SENT, BELOW], `the marker must go from the sent row straight to the row below it: ${JSON.stringify(frames.filter((f, i) => i === 0 || frames[i - 1].row !== f.row))}`)
    const strayed = frames.filter((f) => f.row !== null && f.band !== "queue")
    assert.deepEqual(strayed, [], `the marker was drawn outside the Queue band: ${JSON.stringify(strayed.slice(0, 6))}`)
    assert.equal(frames.some((f) => f.row === ABOVE), false, "the marker visited the card above while the sent card faded")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a dispatch from the prompt box adds one Running row at the click — no row above it ever moves", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  type Frame = { t: number; label: number | null; rows: Record<string, number>; starting: number | null; real: number | null; card: boolean; runningCount: string | null }
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html?dispatchMs=400`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-sidebar-item="${BELOW}"]`)
    const box = "aside textarea"
    await page.waitForSelector(box)
    await page.click(box)
    await page.type(box, "Audit the release pipeline for unsigned artifacts.")
    await new Promise((r) => setTimeout(r, 300))

    await page.evaluate(() => {
      const w = window as unknown as { __railFrames: unknown[] }
      w.__railFrames = []
      const t0 = performance.now()
      const top = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().top * 100) / 100 : null)
      const tick = () => {
        const rail = document.querySelector("[data-sidebar-rail]")!
        const labels = [...rail.querySelectorAll<HTMLElement>(".uppercase")]
        const rows: Record<string, number> = {}
        for (const row of rail.querySelectorAll<HTMLElement>("[data-sidebar-item]")) if (row.dataset.sidebarItem !== "started-thread") rows[row.dataset.sidebarItem!] = top(row)!
        w.__railFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          label: top(labels[0] ?? null),
          rows,
          starting: top(rail.querySelector("[data-sidebar-starting]")),
          real: top(rail.querySelector('[data-sidebar-item="started-thread"]')),
          card: !!document.querySelector("aside [data-pending-dispatch]"),
          runningCount: labels.find((l) => /^running/i.test(l.innerText.trim()))?.innerText.trim().split(/\s+/)[1] ?? null,
        })
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.keyboard.press("Enter")
    await page.waitForSelector('[data-sidebar-item="started-thread"]', { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 1000))
    const frames = (await page.evaluate(() => (window as unknown as { __railFrames: unknown[] }).__railFrames)) as Frame[]

    assert.ok(frames.length > 30, `expected a full sampling window, got ${frames.length} frames`)
    const first = frames[0]
    // Nothing that was in the rail moves: not the Queue label, not one of its rows.
    const moved = frames.filter((f) => f.label !== first.label || Object.entries(first.rows).some(([id, y]) => f.rows[id] !== y))
    assert.deepEqual(moved.slice(0, 4), [], "a rail row moved while the thread was starting")
    assert.equal(frames.some((f) => f.card), false, "the Starting thread… card was mounted under the prompt box")

    // The pending thread is a Running row from the click, and the real row takes exactly its place.
    const pending = frames.filter((f) => f.starting !== null)
    const landed = frames.filter((f) => f.real !== null)
    assert.ok(pending.length > 5, `the starting row must stand for the length of the dispatch call: ${pending.length} frames`)
    assert.ok(pending[0].t < 150, `the starting row appeared late: ${pending[0].t}ms`)
    assert.ok(landed.length > 5, "the thread's own row must land")
    assert.equal(new Set([...pending.map((f) => f.starting), ...landed.map((f) => f.real)]).size, 1, `the row moved when the real one replaced the stand-in: ${JSON.stringify([...new Set(pending.map((f) => f.starting))])} → ${JSON.stringify([...new Set(landed.map((f) => f.real))])}`)
    // One row throughout: never both (drawn twice), and never neither once it has appeared (a blink).
    const from = frames.indexOf(pending[0])
    const wrong = frames.slice(from).filter((f) => (f.starting !== null) === (f.real !== null))
    assert.deepEqual(wrong.slice(0, 4), [], "the stand-in and the real row were drawn together, or neither was")
    assert.deepEqual([...new Set(frames.slice(from).map((f) => f.runningCount))], ["1"], "the Running count changed while the thread was starting")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// The Console's rail, either grouping. `pick` is the project the prompt box's chip points at.
type ConsoleFrame = { t: number; tops: Record<string, number>; starting: number | null; startingIn: string | null; real: number | null; realIn: string | null; card: boolean }
async function recordConsoleDispatch(group: "status" | "project", pick: string): Promise<{ frames: ConsoleFrame[]; errors: string[] }> {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html?surface=console&group=${group}&pick=${pick}&dispatchMs=400`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-console-sidebar] [data-sidebar-item="beta~long-job-beta"]')
    const box = "aside textarea"
    await page.waitForSelector(box)
    await page.click(box)
    await page.type(box, "Audit the release pipeline for unsigned artifacts.")
    await new Promise((r) => setTimeout(r, 300))

    await page.evaluate(() => {
      const w = window as unknown as { __consoleFrames: unknown[] }
      w.__consoleFrames = []
      const t0 = performance.now()
      const top = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().top * 100) / 100 : null)
      const block = (el: Element | null) => el?.closest<HTMLElement>("[data-console-project]")?.dataset.consoleProject ?? null
      const tick = () => {
        const rail = document.querySelector("[data-sidebar-rail]")!
        // Everything the rail drew before the click, by a name that survives the dispatch: band labels by
        // their word (the count beside it changes), project headers, rows, and the view chips.
        const tops: Record<string, number> = {}
        tops.chips = top(document.querySelector("[data-rail-view-chips]"))!
        for (const label of rail.querySelectorAll<HTMLElement>(".uppercase")) tops[`label:${label.innerText.trim().split(/\s+/)[0].toLowerCase()}`] = top(label)!
        for (const header of rail.querySelectorAll<HTMLElement>("[data-console-project-header]")) tops[`project:${block(header)}`] = top(header)!
        for (const row of rail.querySelectorAll<HTMLElement>("[data-sidebar-item]")) if (!row.dataset.sidebarItem!.endsWith("~started-thread")) tops[`row:${row.dataset.sidebarItem}`] = top(row)!
        const starting = rail.querySelector("[data-sidebar-starting]")
        const real = rail.querySelector('[data-sidebar-item$="~started-thread"]')
        w.__consoleFrames.push({ t: +(performance.now() - t0).toFixed(1), tops, starting: top(starting), startingIn: block(starting), real: top(real), realIn: block(real), card: !!document.querySelector("[data-pending-dispatch]") })
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
      }
      // The first sample is taken HERE, not on the next frame: Enter can land before that frame does,
      // and the comparison below needs the rail as it stood before the click.
      tick()
    })
    await page.keyboard.press("Enter")
    await page.waitForSelector('[data-sidebar-item$="~started-thread"]', { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 1000))
    const frames = (await page.evaluate(() => (window as unknown as { __consoleFrames: unknown[] }).__consoleFrames)) as ConsoleFrame[]
    return { frames, errors }
  } finally {
    await browser.close()
  }
}

/** What a Console dispatch may do to the rail: the row appears once, the real one takes its place, and
 *  whatever had to make room for it moved in that one frame and never again. */
function assertOneArrival(frames: ConsoleFrame[]): { pending: ConsoleFrame[]; landed: ConsoleFrame[]; moved: string[] } {
  assert.ok(frames.length > 30, `expected a full sampling window, got ${frames.length} frames`)
  assert.equal(frames.some((f) => f.card), false, "the Starting thread… card was mounted under the Console's prompt box")
  const pending = frames.filter((f) => f.starting !== null)
  const landed = frames.filter((f) => f.real !== null)
  assert.ok(pending.length > 5, `the starting row must stand for the length of the dispatch call: ${pending.length} frames`)
  assert.ok(pending[0].t < 150, `the starting row appeared late: ${pending[0].t}ms`)
  assert.ok(landed.length > 5, "the thread's own row must land")
  assert.equal(new Set([...pending.map((f) => f.starting), ...landed.map((f) => f.real)]).size, 1, "the row moved when the real one replaced the stand-in")
  const from = frames.indexOf(pending[0])
  const wrong = frames.slice(from).filter((f) => (f.starting !== null) === (f.real !== null))
  assert.deepEqual(wrong.slice(0, 4), [], "the stand-in and the real row were drawn together, or neither was")
  // Before the click nothing moves; from the frame the row appears, nothing moves again.
  const first = frames[0]
  const still = (a: ConsoleFrame, b: ConsoleFrame) => Object.entries(a.tops).filter(([key, y]) => key in b.tops && b.tops[key] !== y).map(([key]) => key)
  for (const f of frames.slice(0, from)) assert.deepEqual(still(first, f), [], "the rail moved before the row appeared")
  const arrived = frames[from]
  for (const f of frames.slice(from)) assert.deepEqual(still(arrived, f), [], `the rail moved again after the row appeared (at ${f.t}ms)`)
  return { pending, landed, moved: still(first, arrived) }
}

test("the Console, by status: a dispatch is one Running row at the click, and only the rows under it make room, once", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { frames, errors } = await recordConsoleDispatch("status", "beta")
  const { moved } = assertOneArrival(frames)
  // The new row leads the Running band; the two rows already running step down under it. The Queue
  // band above, its label, the Running label and the view chips are where they were.
  assert.deepEqual(moved.sort(), ["row:alpha~long-job-alpha", "row:beta~long-job-beta"], "something other than the Running rows under the new one moved")
  assert.deepEqual(errors, [])
})

test("the Console, by project: the row is drawn in its own project's block, and a project with nothing else opens its block at the click", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // Into a project that already has a block: the row leads that block's running rows.
  const into = await recordConsoleDispatch("project", "beta")
  const first = assertOneArrival(into.frames)
  assert.deepEqual([...new Set(first.pending.map((f) => f.startingIn))], ["beta"], "the starting row was drawn outside its project's block")
  assert.deepEqual([...new Set(first.landed.map((f) => f.realIn))], ["beta"])
  // Alpha's block is above beta's and holds still; in beta's, only the row already running steps down.
  assert.deepEqual(first.moved, ["row:beta~long-job-beta"], "something other than the block's own running row moved")
  assert.deepEqual(into.errors, [])

  // Into a project with nothing waiting or running: its block is the row's, from the click.
  const fresh = await recordConsoleDispatch("project", "gamma")
  const second = assertOneArrival(fresh.frames)
  assert.deepEqual([...new Set(second.pending.map((f) => f.startingIn))], ["gamma"])
  assert.equal(fresh.frames[0].tops["project:gamma"], undefined, "gamma had no block before the dispatch")
  const header = fresh.frames.filter((f) => f.tops["project:gamma"] !== undefined)
  assert.equal(header[0].t, second.pending[0].t, "the block's header must arrive with the row, not after it")
  assert.equal(new Set(header.map((f) => f.tops["project:gamma"])).size, 1)
  // Gamma is last in the rail's order, so its block opens under the others and nothing above it moves.
  assert.deepEqual(second.moved, [], "a block above the new one moved")
  assert.deepEqual(fresh.errors, [])
})

test("the first-run prompt box: the Starting thread… card hangs under the form and lifts nothing", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  type Frame = { t: number; heading: number | null; box: number | null; boxBottom: number | null; card: number | null; scrollY: number }
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    // A slow dispatch, so the card stands long enough to be judged.
    await page.goto(`${baseUrl}/queue-rail-fixture.html?surface=first-run&dispatchMs=700`, { waitUntil: "networkidle0" })
    const box = "main textarea"
    await page.waitForSelector(box)
    await page.click(box)
    await page.type(box, "Audit the release pipeline for unsigned artifacts.")
    await new Promise((r) => setTimeout(r, 300))

    await page.evaluate(() => {
      const w = window as unknown as { __firstRunFrames: unknown[] }
      w.__firstRunFrames = []
      const t0 = performance.now()
      const q = (n: number) => Math.round(n * 100) / 100
      const tick = () => {
        const heading = [...document.querySelectorAll<HTMLElement>("main h2")].find((h) => /What should the agent do/.test(h.innerText)) ?? null
        const form = document.querySelector("main textarea")?.closest("[data-composer-box]") ?? null
        const card = document.querySelector("[data-pending-dispatch]")
        w.__firstRunFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          heading: heading ? q(heading.getBoundingClientRect().top) : null,
          box: form ? q(form.getBoundingClientRect().top) : null,
          boxBottom: form ? q(form.getBoundingClientRect().bottom) : null,
          card: card ? q(card.getBoundingClientRect().top) : null,
          scrollY: window.scrollY,
        })
        if (performance.now() - t0 < 600) requestAnimationFrame(tick)
      }
      tick() // before the click, for the same reason as on the Console
    })
    await page.keyboard.press("Enter")
    await new Promise((r) => setTimeout(r, 750))
    const frames = (await page.evaluate(() => (window as unknown as { __firstRunFrames: unknown[] }).__firstRunFrames)) as Frame[]

    assert.ok(frames.length > 20, `expected a full sampling window, got ${frames.length} frames`)
    const withCard = frames.filter((f) => f.card !== null)
    assert.ok(withCard.length > 10, `the card must stand while the dispatch call runs: ${withCard.length} frames`)
    // The form is centred in the window: anything that takes height in its column moves all of it.
    const first = frames[0]
    assert.ok(first.heading !== null && first.box !== null)
    const moved = frames.filter((f) => f.heading !== first.heading || f.box !== first.box || f.scrollY !== first.scrollY)
    assert.deepEqual(moved.slice(0, 4), [], "the heading or the prompt box moved while the thread was starting")
    // Under the form by the column's own 12px gap, where it sat when it took height.
    assert.equal(new Set(withCard.map((f) => f.card)).size, 1, "the card moved while it stood")
    assert.ok(Math.abs(withCard[0].card! - withCard[0].boxBottom! - 12) <= 1, `the card must hang 12px under the box: box bottom ${withCard[0].boxBottom}, card ${withCard[0].card}`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})


test("stacked layout: a row arriving in the rail is absorbed by the scroll offset — the cards on screen hold", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  type Frame = { t: number; scrollY: number; card: number; railBottom: number; started: boolean }
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 780, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    // The reader is in the queue with the END of the rail still on screen above the first card: the
    // arrangement in which the rail, being first on screen, used to be the anchor.
    const railBottom = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>("[data-sidebar-rail]")!
      window.scrollTo(0, window.scrollY + rail.getBoundingClientRect().bottom - 80)
      return rail.getBoundingClientRect().bottom
    })
    assert.ok(railBottom > 40 && railBottom < 200, `the rail's last rows must be on screen: bottom at ${railBottom}`)
    await page.waitForFunction(() => document.querySelector("aside")!.hasAttribute("data-queue-in-view"))
    await new Promise((r) => setTimeout(r, 300))

    await page.evaluate((first: string) => {
      const w = window as unknown as { __stackedFrames: unknown[]; __startElsewhere: () => void }
      w.__stackedFrames = []
      const t0 = performance.now()
      const q = (n: number) => Math.round(n * 100) / 100
      const tick = () => {
        w.__stackedFrames.push({
          t: +(performance.now() - t0).toFixed(1),
          scrollY: q(window.scrollY),
          card: q(document.querySelector(`[data-queue-card="${first}"]`)!.getBoundingClientRect().top),
          railBottom: q(document.querySelector("[data-sidebar-rail]")!.getBoundingClientRect().bottom),
          started: !!document.querySelector('[data-sidebar-item="started-elsewhere"]'),
        })
        if (performance.now() - t0 < 700) requestAnimationFrame(tick)
      }
      tick()
      window.setTimeout(() => w.__startElsewhere(), 150)
    }, ABOVE)
    await page.waitForSelector('[data-sidebar-item="started-elsewhere"]', { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 700))
    const frames = (await page.evaluate(() => (window as unknown as { __stackedFrames: unknown[] }).__stackedFrames)) as Frame[]

    const before = frames.filter((f) => !f.started)
    const after = frames.filter((f) => f.started)
    assert.ok(before.length > 3 && after.length > 10, `expected frames on both sides of the arrival: ${before.length} / ${after.length}`)
    // The first Running row brings its label and the rule above it: the rail grew by all three.
    const grew = after[after.length - 1].scrollY - before[0].scrollY
    assert.ok(grew > 20, `the rail must have grown above the queue and the offset absorbed it: scrollY moved ${grew}px`)
    assert.deepEqual([...new Set(frames.map((f) => f.card))], [before[0].card], `the first card moved on screen: ${JSON.stringify(frames.filter((f, i) => i === 0 || frames[i - 1].card !== f.card).map((f) => [f.t, f.card, f.scrollY]))}`)
    assert.equal(after[0].scrollY - before[0].scrollY, grew, "the offset must move in the frame the row arrives, not after it")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("stacked layout: the rail stays the scroll anchor while no queue card is on screen", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    // A window too short to show the queue under the rail: a reader inside the rail has only the rail
    // to anchor to, and taking it away would move the rows they are reading instead of the cards.
    await page.setViewport({ width: 780, height: 240, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/queue-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    const state = () => page.evaluate(() => {
      const aside = document.querySelector("aside")!
      return { flagged: aside.hasAttribute("data-queue-in-view"), anchor: getComputedStyle(aside).overflowAnchor, queueTop: document.getElementById("workpane")!.getBoundingClientRect().top }
    })
    await new Promise((r) => setTimeout(r, 300))
    const inRail = await state()
    assert.ok(inRail.queueTop > 240, `the queue must start below this window: ${inRail.queueTop}`)
    assert.deepEqual([inRail.flagged, inRail.anchor], [false, "auto"])

    await page.evaluate(() => document.querySelector("[data-queue-card]")!.scrollIntoView())
    await page.waitForFunction(() => document.querySelector("aside")!.hasAttribute("data-queue-in-view"))
    assert.equal((await state()).anchor, "none")

    // Beside the queue (over 800px) the rail is its own column and is never excluded.
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await state()).anchor, "auto")
  } finally {
    await browser.close()
  }
})

// Where the card being read sits, frame by frame, from before a card arrives until it has settled.
type ArrivalFrame = { t: number; scrollY: number; reading: number; arrived: boolean }

async function recordArrival(page: import("puppeteer").Page, reading: string, restedAt: string | null): Promise<ArrivalFrame[]> {
  await page.evaluate((reading: string, restedAt: string | null) => {
    const w = window as unknown as { __arrivalFrames: unknown[]; __arriveInQueue: (id?: string, restedAt?: string) => void }
    w.__arrivalFrames = []
    const t0 = performance.now()
    const tick = () => {
      w.__arrivalFrames.push({
        t: +(performance.now() - t0).toFixed(1),
        scrollY: Math.round(window.scrollY * 100) / 100,
        reading: Math.round(document.querySelector(`[data-queue-card="${reading}"]`)!.getBoundingClientRect().top * 100) / 100,
        arrived: !!document.querySelector('[data-queue-card="arrived-card"]'),
      })
      if (performance.now() - t0 < 4_500) requestAnimationFrame(tick)
    }
    tick()
    window.setTimeout(() => w.__arriveInQueue("arrived-card", restedAt ?? undefined), 150)
  }, reading, restedAt)
  // The card is held out of the list until its reply has caught up (lib/queueReturn), up to a cap.
  await page.waitForSelector('[data-queue-card="arrived-card"]', { timeout: 8_000 })
  await new Promise((r) => setTimeout(r, 4_600))
  return page.evaluate(() => (window as unknown as { __arrivalFrames: ArrivalFrame[] }).__arrivalFrames)
}

function assertReaderHeld(frames: ArrivalFrame[]): void {
  const before = frames.filter((f) => !f.arrived)
  const after = frames.filter((f) => f.arrived)
  assert.ok(before.length > 3 && after.length > 10, `expected frames on both sides of the arrival: ${before.length} / ${after.length}`)
  // The new card went in above the reader, so the offset had to absorb its whole height.
  const grew = after[after.length - 1].scrollY - before[0].scrollY
  assert.ok(grew > 200, `the card must have arrived above the reader and the offset absorbed it: scrollY moved ${grew}px`)
  const moved = frames.filter((f) => Math.abs(f.reading - before[0].reading) > 0.5).map((f) => [f.t, f.reading, f.scrollY])
  assert.deepEqual(moved, [], `the card being read must not move on screen in any frame (it sat at ${before[0].reading})`)
}

test("newest first, at the top of the page: a card arriving above the one being read leaves it where it is", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => localStorage.setItem("frizz.prefs.v1", JSON.stringify({ queueOrder: "lifo" })))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${ABOVE}"]`)
    await new Promise((r) => setTimeout(r, 300))
    // Newest first, so the top card is the last of CARDS, and the reader is reading it at the origin —
    // the one offset native anchoring never corrects.
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>("[data-queue-card]")!.dataset.queueCard), BELOW)
    assert.equal(await page.evaluate(() => window.scrollY), 0)
    assertReaderHeld(await recordArrival(page, BELOW, null))
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>("[data-queue-card]")!.dataset.queueCard), "arrived-card")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("with no native scroll anchoring (iOS Safari): a card returning above the reader leaves them where they are", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${baseUrl}/queue-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`[data-queue-card-root="${BELOW}"]`)
    await page.evaluate((sent: string) => {
      const style = document.createElement("style")
      style.textContent = "*, html, body { overflow-anchor: none !important }"
      document.head.append(style)
      const card = document.querySelector<HTMLElement>(`[data-queue-card="${sent}"]`)!
      window.scrollTo(0, window.scrollY + card.getBoundingClientRect().top - 120)
    }, SENT)
    await new Promise((r) => setTimeout(r, 300))
    // Oldest first, and this card's rest is older than every card here: back from a snooze, it lands
    // at the top of the queue, above the card being read.
    assertReaderHeld(await recordArrival(page, SENT, new Date(Date.now() - 3_600_000).toISOString()))
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>("[data-queue-card]")!.dataset.queueCard), "arrived-card")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
