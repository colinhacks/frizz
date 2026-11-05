import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the TIMELINE RAIL (lib/diff/diff.css, ChatView ToolRailRows). Skipped unless a Vite
// URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in
// packages/web and set FRIZZ_TOOL_RAIL_E2E_URL to its origin.
//
// Measured in a real browser because every fact here is layout: the row's marks sit on its text's cap band
// only if the fonts, the line box and the baseline all agree, and which segments of the line draw is decided
// by CSS selectors over the row's DOM neighbours.
const baseUrl = process.env.FRIZZ_TOOL_RAIL_E2E_URL

type Row = {
  label: string
  height: number
  top: number
  bottom: number
  above: boolean
  below: boolean
  lineShown: boolean
  nodeShown: boolean
  nodeOffset: number
  markOffset: number | null
  chevronOffset: number | null
  nodeBackground: string
  nodeBorder: string
  tailRight: number
  readingRight: number | null
  reading: string
  readingTitle: string | null
}

async function launch(width: number) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width, height: 1600, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// Every row of one fixture case, with each mark's centre measured from the cap band of the label beside it.
function readRows(page: import("puppeteer").Page, name: string): Promise<Row[]> {
  return page.evaluate((caseName) => {
    const capMiddle = (label: HTMLElement) => {
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0"
      label.appendChild(probe)
      const baseline = probe.getBoundingClientRect().bottom
      probe.remove()
      const cs = getComputedStyle(label)
      const ctx = document.createElement("canvas").getContext("2d")!
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      return baseline - ctx.measureText("H").actualBoundingBoxAscent / 2
    }
    const scope = document.querySelector(`[data-case="${caseName}"]`)!
    return [...scope.querySelectorAll<HTMLElement>(".frizz-bash, .frizz-diff")].map((row) => {
      const header = row.querySelector<HTMLElement>(".frizz-bash-header, .frizz-diff-header")!
      const label = header.querySelector<HTMLElement>(".frizz-bash-label")!
      const middle = capMiddle(label)
      const box = row.getBoundingClientRect()
      const line = getComputedStyle(row, "::before")
      const node = getComputedStyle(row, "::after")
      const mark = header.querySelector<HTMLElement>(".frizz-tool-mark > *")
      const markBox = mark?.getBoundingClientRect()
      const chevron = header.querySelector(".frizz-tool-chevron path")?.getBoundingClientRect()
      const reading = header.lastElementChild!.querySelector<HTMLElement>("[aria-label]:not([data-tool-disclosure])")
      const offset = (n: number) => Math.round((n - middle) * 100) / 100
      return {
        label: label.textContent ?? "",
        height: header.getBoundingClientRect().height,
        top: box.top,
        bottom: box.bottom,
        above: line.getPropertyValue("--rail-above").trim() !== "",
        below: line.getPropertyValue("--rail-below").trim() !== "",
        lineShown: line.backgroundImage !== "none",
        nodeShown: node.display !== "none",
        nodeOffset: offset(box.top + parseFloat(node.top) + 4),
        markOffset: markBox ? offset((markBox.top + markBox.bottom) / 2) : null,
        chevronOffset: chevron ? offset((chevron.top + chevron.bottom) / 2) : null,
        nodeBackground: node.backgroundColor,
        nodeBorder: node.borderTopColor,
        tailRight: header.lastElementChild!.getBoundingClientRect().right,
        readingRight: reading ? reading.getBoundingClientRect().right : null,
        reading: (reading?.textContent ?? "").trim(),
        readingTitle: reading?.getAttribute("title") ?? null,
      }
    })
  }, name)
}

test("a run of tool rows draws one rail, with every mark on its row's cap band", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page, errors } = await launch(1000)
  try {
    await page.goto(`${baseUrl}/tool-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-case="digest"] .frizz-bash')

    const digest = await readRows(page, "digest")
    assert.equal(digest.length, 10)
    for (const [i, row] of digest.entries()) {
      // One pitch: a mono detail, a smaller reading or an Edit's counts must not grow a row by a fraction.
      assert.equal(row.height, 26, `${row.label}: one row, one height`)
      if (i > 0) assert.equal(row.top, digest[i - 1].bottom, `${row.label}: rows on a rail sit edge to edge`)
      // The line stops at the first node and at the last.
      assert.equal(row.above, i > 0, `${row.label}: a segment above unless it is the first row`)
      assert.equal(row.below, i < digest.length - 1, `${row.label}: a segment below unless it is the last row`)
      assert.ok(Math.abs(row.nodeOffset) <= 0.3, `${row.label}: the node sits ${row.nodeOffset}px off the cap band`)
      if (row.chevronOffset !== null) assert.ok(Math.abs(row.chevronOffset) <= 0.3, `${row.label}: the chevron sits ${row.chevronOffset}px off the cap band`)
    }
    // A row with no body reserves the chevron's column, so the readings keep one right edge.
    assert.ok(digest.some((row) => row.chevronOffset === null), "the fixture must include a row with no body")
    assert.equal(new Set(digest.map((row) => row.readingRight)).size, 1, "every reading ends at one right edge")
    assert.equal(new Set(digest.map((row) => row.tailRight)).size, 1, "every row ends at one right edge")

    // The node says what the call did, in the reading's own colour when it went wrong.
    const byReading = (needle: string) => digest.find((row) => row.reading.includes(needle))!
    const hollow = digest.find((row) => row.label === "Read")!
    const edit = digest.find((row) => row.label === "Edit")!
    assert.equal(hollow.nodeBackground, "rgba(0, 0, 0, 0)", "a read leaves its node hollow")
    assert.notEqual(edit.nodeBackground, "rgba(0, 0, 0, 0)", "an edit fills it")
    assert.notEqual(byReading("exit 1").nodeBackground, "rgba(0, 0, 0, 0)", "a failure fills it")
    assert.notEqual(byReading("exit 1").nodeBackground, edit.nodeBackground, "…in red, not the edit's gray")
    assert.equal(byReading("cancelled").nodeBackground, "rgba(0, 0, 0, 0)", "a cancellation stays hollow")
    assert.notEqual(byReading("cancelled").nodeBorder, hollow.nodeBorder, "…with an amber ring")

    // A nominal finish draws only its time; the word survives where length costs nothing.
    const finished = digest.find((row) => row.reading === "1.2s")!
    assert.equal(finished.readingTitle, "done · 1.2s")
    assert.equal(digest.filter((row) => /done/.test(row.reading)).length, 0, "no row draws the word")

    // Something alive behind a row replaces its node, in the same place.
    const exceptions = await readRows(page, "exceptions")
    const marked = exceptions.filter((row) => row.markOffset !== null)
    assert.equal(marked.length, 4, "running, stale and rested children, and a live shell")
    for (const row of marked) {
      assert.equal(row.nodeShown, false, `${row.label}: the mark stands in for the node`)
      assert.ok(Math.abs(row.markOffset!) <= 0.3, `${row.label}: the mark sits ${row.markOffset}px off the cap band`)
    }
    assert.equal(exceptions.filter((row) => row.above && row.below).length, exceptions.length - 2, "the exceptions share one rail too")

    // A lone row has no line at all.
    const [lone] = await readRows(page, "lone")
    assert.deepEqual([lone.above, lone.below], [false, false])

    // Two messages keep two rails, at the tight run, so a provider's batching still reads as a break.
    const split = await readRows(page, "split")
    assert.deepEqual(split.map((row) => [row.above, row.below]), [[false, false], [false, false]])
    assert.equal(split[1].top - split[0].bottom, 6)

    // A steer's divider is not a row, so it ends the rail on both sides rather than crossing it.
    const mixed = await readRows(page, "mixed")
    assert.deepEqual(mixed.map((row) => [row.above, row.below]), [[false, false], [false, false]])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the line runs through an open body to the next row", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch(1000)
  try {
    await page.goto(`${baseUrl}/tool-rail-fixture.html?open=1`, { waitUntil: "networkidle0" })
    await page.waitForFunction(() => document.querySelectorAll('[data-case="open"] .frizz-tool-body:not([hidden])').length >= 4, { timeout: 15_000 })
    const rows = await readRows(page, "open")
    const run = rows.slice(0, 4)
    for (const [i, row] of run.entries()) {
      if (i > 0) assert.equal(row.top, run[i - 1].bottom, `${row.label}: an open body's air stays inside its row`)
      assert.ok(row.bottom - row.top > 26, `${row.label}: its body is open`)
    }
    const bodies = await page.$$eval('[data-case="open"] .frizz-bash-header + .frizz-tool-body, [data-case="open"] [data-expanded] + .frizz-tool-body', (nodes) =>
      nodes.map((node) => getComputedStyle(node).backgroundColor))
    assert.ok(bodies.length >= 4 && new Set(bodies).size === 1, "every open row draws one inset body")
    // A Bash command's pane says `$`; structured tool input is labelled instead, because it is not shell.
    assert.equal(await page.$eval('[data-case="open"] .frizz-bash-command', (node) => getComputedStyle(node, "::before").content), '"$ "')
    assert.equal(await page.$$eval('[data-case="open"] .frizz-bash-output-label', (nodes) => nodes.map((node) => node.textContent).join(",")), "Input,Output")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a narrow column truncates the folder and keeps the filename", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch(420)
  try {
    await page.goto(`${baseUrl}/tool-rail-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-case="digest"] .frizz-tool-path')
    const paths = await page.$$eval('[data-case="digest"] .frizz-tool-path', (nodes) => nodes.map((node) => {
      const dir = node.querySelector<HTMLElement>(".frizz-tool-path-dir")!
      const base = node.querySelector<HTMLElement>(".frizz-tool-path-base")!
      return { base: base.textContent, baseClipped: base.scrollWidth > base.clientWidth, dirClipped: dir.scrollWidth > dir.clientWidth }
    }))
    const long = paths.find((path) => path.base === "ChatView.tsx" && path.dirClipped)
    assert.ok(long, `the long path's folder must truncate, got ${JSON.stringify(paths)}`)
    for (const path of paths) assert.equal(path.baseClipped, false, `${path.base} must stay whole`)
    // Nothing escapes its row, however long the detail.
    const escapes = await page.$$eval(".frizz-bash, .frizz-diff", (rows) => rows.filter((row) => {
      const header = row.querySelector(".frizz-bash-header, .frizz-diff-header")!
      return header.scrollWidth > header.clientWidth + 1
    }).length)
    assert.equal(escapes, 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
