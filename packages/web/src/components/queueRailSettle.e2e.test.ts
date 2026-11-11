import assert from "node:assert/strict"
import test from "node:test"

// THE RAIL HOLDS STILL WHILE THE HUMAN DISPATCHES. Runtime coverage for what it did instead, recorded
// frame by frame on 2026-10-13 against a stack whose worker is the scripted Claude:
//
//   1. A dispatch from the prompt box mounted a "Starting thread…" card between the box and the rail for
//      the length of the dispatch call: every row moved down 73px at the click and back up when the call
//      answered (5 of 5). The rail now draws the pending thread as the Running row it becomes
//      (lib/pendingDispatch), so one row appears and nothing else moves.
//
//   2. The Console's prompt box and the first-run one still mounted that card. On the Console every row
//      moved down 93px and back up, in either grouping (3 of 3 each); it draws the Running row now, in
//      the project's own block when the list is grouped by project. On a board with no thread there is
//      no rail to draw a row in, and the form is centred in the window, so the card lifted the heading
//      and the box 36-37px (3 of 3). The card stays there and floats under the form instead.
//
// It also pinned the queue's cards beside the rail — the scroll marker's handover on a send, the
// stacked layout's scroll anchor, and the reader held through a card arriving above them — until the
// one-thread pane replaced the cards (2026-11-09) and they went (2026-11-10).
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): `nub run test:e2e -- queueRailSettle.e2e.test.ts`, or start `vite` in packages/web and set
// FRIZZ_QUEUE_RAIL_SETTLE_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_QUEUE_RAIL_SETTLE_E2E_URL

const BELOW = "flaky-e2e"

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
