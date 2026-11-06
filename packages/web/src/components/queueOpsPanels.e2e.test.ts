import assert from "node:assert/strict"
import test from "node:test"

// EACH COUNT OVER A PROMPT BOX OPENS ITS OWN PANEL (maintainer 2026-10-11: "there should be a popover
// for each of the different categories … If you hover over Files, it should show the files. If you
// hover over the pull request watchers, it should show the pull request"). Until then the whole line
// was one control over one panel listing every row. Hover, the pointer's path into a panel and the
// keyboard's way in are all browser facts, so they are driven in one against the real queue card.
//
//   nub run test:e2e -- queueOpsPanels.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUEUE_OPS_PANELS_E2E_URL

// The fixture's rows, by the count that must list them (queue-ops-spacing-fixture.tsx).
const ROWS = {
  agent: ["Diff the queue card against the drawer footer"],
  shell: ["Poll panes for perm-prompt false positives", "Poll panes for near-miss perm markers", "Record 5min of frizz board SSE"],
  pr: ["colinhacks/zod#6559", "nubjs/nub#874"],
  issue: ["colinhacks/frizz#61"],
  file: ["Structured restriction report", "HKS pair-merge report"],
  link: ["Dev server"],
} as const
type Kind = keyof typeof ROWS
const KINDS = Object.keys(ROWS) as Kind[]

test("each op count opens a panel of its own rows, one panel at a time", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/queue-ops-spacing-fixture.html?agents=1&links=1&watches=1`, { waitUntil: "networkidle0" })
    await page.evaluate(() => { document.documentElement.dataset.font = "sans" })
    await page.waitForSelector("[data-queue-ops-summary] [data-ops-count]")

    const count = (kind: Kind) => `[data-queue-ops-summary] [data-ops-count="${kind}"]`
    const panel = (kind: Kind) => `[data-queue-ops-panel="${kind}"]`
    const openPanels = () => page.$$eval("[data-queue-ops-panel]", (els) => els.map((el) => (el as HTMLElement).dataset.queueOpsPanel))
    const assertOnly = async (kind: Kind) => {
      await page.waitForSelector(panel(kind))
      // The panel a pointer just left unmounts with the same render that mounts the next one.
      await page.waitForFunction(() => document.querySelectorAll("[data-queue-ops-panel]").length === 1)
      const text = await page.$eval(panel(kind), (el) => (el as HTMLElement).innerText)
      for (const row of ROWS[kind]) assert.ok(text.includes(row), `the ${kind} panel lists "${row}", got ${JSON.stringify(text)}`)
      for (const other of KINDS.filter((k) => k !== kind)) {
        for (const row of ROWS[other]) assert.ok(!text.includes(row), `the ${kind} panel must not list the ${other} row "${row}"`)
      }
    }

    assert.deepEqual(
      await page.$$eval("[data-queue-ops-summary] [data-ops-count]", (els) => els.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      ["1 agent", "3 shells", "2 PRs", "1 issue", "2 files", "1 link"],
    )
    assert.deepEqual(await openPanels(), [], "nothing is open until a count is hovered")

    // 1. Hover: every count, left to right. Going straight from one to the next swaps the panel — and
    // every panel opens in the same place, flush with the prompt box's right edge and sitting on the rule
    // over the line (maintainer 2026-10-17: "those popovers should always show up in the same place").
    // Its triangle stands over the middle of the count that opened it, its rows are a menu's, 30px and on
    // one line, and a panel of one row is that row and the panel's own 4px and border.
    const boxRight = await page.$eval("[data-queue-ops-summary] + [data-composer-box]", (el) => el.getBoundingClientRect().right)
    const placed: { kind: Kind; left: number; right: number; overLine: number; caretOff: number; caretTip: number; rows: number[]; height: number }[] = []
    for (const kind of KINDS) {
      await page.hover(count(kind))
      await assertOnly(kind)
      assert.equal(await page.$eval(count(kind), (el) => el.getAttribute("aria-expanded")), "true")
      placed.push({ kind, ...await page.evaluate((countSel, panelSel) => {
        const c = document.querySelector(countSel)!.getBoundingClientRect()
        const panel = document.querySelector(panelSel)!
        const p = panel.getBoundingClientRect()
        const line = document.querySelector("[data-queue-ops-summary]")!.getBoundingClientRect()
        const caret = panel.querySelector("[data-queue-ops-caret]")!.getBoundingClientRect()
        const rows = [...panel.querySelectorAll("[data-thread-link], [data-queue-subagents] > *, [data-background-ops] > *:not([data-thread-links])")]
        return {
          left: p.left,
          right: p.right,
          overLine: line.top - p.bottom,
          caretOff: caret.left + caret.width / 2 - (c.left + c.width / 2),
          caretTip: c.top - caret.bottom,
          rows: rows.map((row) => row.getBoundingClientRect().height),
          height: p.height,
        }
      }, count(kind), panel(kind)) })
      // The triangle slides, so it is read once it has arrived.
      await new Promise((resolve) => setTimeout(resolve, 200))
      placed[placed.length - 1]!.caretOff = await page.evaluate((countSel, panelSel) => {
        const c = document.querySelector(countSel)!.getBoundingClientRect()
        const caret = document.querySelector(`${panelSel} [data-queue-ops-caret]`)!.getBoundingClientRect()
        return caret.left + caret.width / 2 - (c.left + c.width / 2)
      }, count(kind), panel(kind))
    }
    for (const at of placed) {
      assert.ok(Math.abs(at.right - boxRight) < 0.5, `the ${at.kind} panel ends at the prompt box's right edge (${at.right} vs ${boxRight})`)
      assert.ok(Math.abs(at.left - placed[0]!.left) < 0.5, `the ${at.kind} panel starts where the ${placed[0]!.kind} panel does (${at.left} vs ${placed[0]!.left})`)
      assert.ok(Math.abs(at.overLine) < 0.5, `the ${at.kind} panel sits on the rule over the line, off by ${at.overLine}`)
      assert.ok(Math.abs(at.caretOff) < 0.5, `the ${at.kind} panel's triangle stands over its count, off by ${at.caretOff}`)
      assert.ok(at.caretTip >= 0, `the ${at.kind} panel's triangle stops short of its count, by ${at.caretTip}`)
      assert.ok(at.rows.length > 0, `the ${at.kind} panel's rows were found`)
      for (const row of at.rows) assert.equal(row, 30, `a ${at.kind} row is 30px, on one line`)
      assert.equal(at.height, at.rows.reduce((sum, row) => sum + row, 0) + 10, `the ${at.kind} panel is its rows, 4px either side, and its border`)
    }

    // 2. The pointer can cross the gap into the panel and stay there: the rows are controls.
    await page.hover(count("shell"))
    await assertOnly("shell")
    const from = (await (await page.$(count("shell")))!.boundingBox())!
    const into = (await (await page.$(panel("shell")))!.boundingBox())!
    assert.ok(into.y + into.height <= from.y, "the panel stands above its count")
    await page.mouse.move(from.x + from.width / 2, into.y + into.height - 12, { steps: 12 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.deepEqual(await openPanels(), ["shell"], "the panel survives the pointer moving into it")
    // …and a row in it is a real control: the stale shell still offers its ×.
    assert.ok(await page.$(`${panel("shell")} button[aria-label="Clear background shell: Poll panes for perm-prompt false positives"]`), "the shell rows keep their ×")

    // …and the whole of a row is the target, out to its reading at the far right.
    await page.evaluate(() => {
      const opened: string[] = []
      ;(window as unknown as { __opened: string[] }).__opened = opened
      window.open = (url) => { opened.push(String(url)); return null }
    })
    await page.hover(count("pr"))
    await assertOnly("pr")
    const prRow = (await (await page.$(`${panel("pr")} [data-background-ops] > *`))!.boundingBox())!
    await page.mouse.move(prRow.x + prRow.width - 16, prRow.y + prRow.height / 2, { steps: 12 })
    await page.mouse.down()
    await page.mouse.up()
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened), ["https://github.com/colinhacks/zod/pull/6559"], "a press on the row's reading opens the row")

    // 3. Leaving both closes it.
    await page.mouse.move(4, 4)
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))

    // 4. A press on a count opens, never toggles: the hover already opened it.
    await page.click(count("pr"))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await openPanels(), ["pr"], "a click on the hovered count leaves its panel open")
    await page.mouse.move(4, 4)
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))

    // 5. The keyboard: focus opens, Tab moves to the next count and swaps the panel, ↓ goes into the
    // panel, Escape comes back to the count and closes it. REAL Tab presses carry the focus, never
    // `element.focus()`: a focus the browser dispatches lets React commit the panel before the event
    // reaches the document, and that is the path on which a panel opened and shut in one keystroke.
    await page.focus(count("issue"))
    await page.keyboard.press("Tab")
    await assertOnly("file")
    await page.keyboard.press("Tab")
    await assertOnly("link")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await openPanels(), ["link"], "the panel a Tab opened stays open")
    await page.keyboard.press("ArrowDown")
    await page.waitForFunction(() => !!document.activeElement?.closest('[data-queue-ops-panel="link"]'))
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.opsCount), "link", "Escape returns focus to the count")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// THE POINTER'S WAY INTO A PANEL (maintainer 2026-11-06: "It's kind of hard to click on the things,
// especially for links, without the little popover going away"). A panel is right-aligned to the line and
// a row's label sits at its far left, so the natural line from "1 link" to its label runs far left and only
// a little up, across its neighbours. It read link → file → issue → closed before this was fixed. Every
// panel that mounts is logged from inside the page, so a swap that came and went between two reads is seen.
test("a count the pointer only crosses on its way to the panel does not take it", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/queue-ops-spacing-fixture.html?agents=1&links=1&watches=1`, { waitUntil: "networkidle0" })
    await page.evaluate(() => {
      document.documentElement.dataset.font = "sans"
      const log: (string | null)[] = []
      ;(window as unknown as { __panels: (string | null)[] }).__panels = log
      new MutationObserver(() => {
        const now = (document.querySelector("[data-queue-ops-panel]") as HTMLElement | null)?.dataset.queueOpsPanel ?? null
        if (log[log.length - 1] !== now) log.push(now)
      }).observe(document.body, { childList: true, subtree: true })
    })
    await page.waitForSelector("[data-queue-ops-summary] [data-ops-count]")
    const count = (kind: string) => `[data-queue-ops-summary] [data-ops-count="${kind}"]`
    const centre = async (selector: string) => {
      const box = (await (await page.$(selector))!.boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const panelLog = async () => page.evaluate(() => {
      const log = (window as unknown as { __panels: (string | null)[] }).__panels
      return log.splice(0, log.length)
    })
    const settled = () => new Promise((resolve) => setTimeout(resolve, 500))

    // 1. From "1 link" to its label, in one shallow line over "2 files" and "1 issue".
    const from = await centre(count("link"))
    await page.mouse.move(from.x, from.y)
    await page.waitForSelector('[data-queue-ops-panel="link"]')
    const row = '[data-queue-ops-panel="link"] [data-thread-link]'
    const label = await centre(`${row} [data-link-label]`)
    const aim = { x: (await (await page.$(`${row} [data-link-label]`))!.boundingBox())!.x + 20, y: label.y }
    await panelLog()
    await page.mouse.move(aim.x, aim.y, { steps: 40 })
    await settled()
    assert.deepEqual(await panelLog(), [], "no other panel mounted on the way, and this one stayed")
    assert.ok(await page.evaluate((point, selector) => !!document.elementFromPoint(point.x, point.y)?.closest(selector), aim, row), "the pointer is on the link, with its panel still under it")

    // 2. Leaving still closes it.
    await page.mouse.move(4, 4, { steps: 4 })
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))

    // A FLICK, whose first event lands on the neighbour. The pointer has not moved since it opened the panel,
    // so where it came in is all the trail has to read its direction from.
    await page.mouse.move(from.x, from.y)
    await page.waitForSelector('[data-queue-ops-panel="link"]')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await panelLog()
    await page.mouse.move(aim.x, aim.y, { steps: 6 })
    await settled()
    assert.deepEqual(await panelLog(), [], "a flick to the same label swaps nothing either")
    await page.mouse.move(4, 4, { steps: 4 })
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))

    // 3. SLIDING ALONG THE LINE IS CHOOSING, so it swaps on the way, the way a menu bar does: holding every
    // swap would pass step 1 and lose this.
    await page.mouse.move(from.x, from.y)
    await page.waitForSelector('[data-queue-ops-panel="link"]')
    await panelLog()
    const issue = await centre(count("issue"))
    await page.mouse.move(issue.x, issue.y, { steps: 20 })
    await page.waitForSelector('[data-queue-ops-panel="issue"]')
    assert.deepEqual((await panelLog()).filter((kind) => kind !== null), ["file", "issue"], "each count on the way took the panel in turn")

    // 4. A rising move that comes to rest on a neighbour was a choice after all: it takes over.
    await page.mouse.move(4, 4, { steps: 4 })
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))
    await page.mouse.move(from.x, from.y)
    await page.waitForSelector('[data-queue-ops-panel="link"]')
    const file = await centre(count("file"))
    await page.mouse.move(file.x, file.y - 3, { steps: 10 })
    await page.waitForSelector('[data-queue-ops-panel="file"]', { timeout: 2_000 })
  } finally {
    await browser.close()
  }
})

// NO PANEL IS AS WIDE AS THE BOX IT OPENS OFF (maintainer 2026-11-06: "There should be no full-width
// popovers like that. There should always be some fraction of the full width of the card"). The Goal panel
// measured exactly 100% of the box here until then.
test("the Goal panel and the op panels take a share of the prompt box", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    // 1100: the card's ordinary box. 520: a box narrow enough for the panels' floor to be what holds.
    for (const [width, most] of [[1100, 0.72], [520, 0.75]] as const) {
      await page.setViewport({ width, height: 800, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/queue-ops-spacing-fixture.html?agents=1&links=1&watches=1`, { waitUntil: "networkidle0" })
      await page.evaluate(() => { document.documentElement.dataset.font = "sans" })

      await page.click("[data-recurring-prompt]")
      await page.waitForFunction(() => !!document.querySelector("[data-radix-popper-content-wrapper] textarea"))
      const goal = await page.evaluate(() => {
        const panel = document.querySelector("[data-radix-popper-content-wrapper] textarea")!.closest("[data-radix-popper-content-wrapper]")!.firstElementChild!.getBoundingClientRect()
        const box = document.querySelector("[data-recurring-prompt]")!.closest("[data-composer-box]")!.getBoundingClientRect()
        return { share: panel.width / box.width, toBoxEnd: panel.right - box.right, left: panel.left, boxLeft: box.left }
      })
      assert.ok(goal.share <= most, `the Goal panel takes ${goal.share} of the box at ${width}px`)
      assert.ok(goal.share >= 0.6, `…and stays a writing surface, at ${goal.share}`)
      assert.ok(Math.abs(goal.toBoxEnd) < 0.5, `it ends on the box's right edge, off by ${goal.toBoxEnd}`)
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => !document.querySelector("[data-radix-popper-content-wrapper] textarea"))

      await page.hover('[data-queue-ops-summary] [data-ops-count="link"]')
      await page.waitForSelector('[data-queue-ops-panel="link"]')
      const share = await page.$eval('[data-queue-ops-panel="link"]', (el) => el.getBoundingClientRect().width / document.querySelector("[data-queue-ops-summary] + [data-composer-box]")!.getBoundingClientRect().width)
      assert.ok(share <= most, `the link panel takes ${share} of the box at ${width}px`)
      // A narrow box moves the counts, not the triangle's job.
      await new Promise((resolve) => setTimeout(resolve, 200))
      const caretOff = await page.evaluate(() => {
        const c = document.querySelector('[data-queue-ops-summary] [data-ops-count="link"]')!.getBoundingClientRect()
        const caret = document.querySelector("[data-queue-ops-caret]")!.getBoundingClientRect()
        return caret.left + caret.width / 2 - (c.left + c.width / 2)
      })
      assert.ok(Math.abs(caretOff) < 0.5, `the triangle stands over its count at ${width}px, off by ${caretOff}`)
      await page.mouse.move(4, 4)
      await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))
    }
  } finally {
    await browser.close()
  }
})

// THE LINE SITS IN THE MIDDLE OF THE SPACE IT IS IN: as far under the rule above the dock as it is over
// the prompt box. It hung 4.6px low until 2026-10-11 (maintainer: "there's more space above the artifact
// chips than below"). Measured on the cap band — baseline to cap height, which is what the eye reads as
// the line of text and what the digits fill — because the counts' boxes carry leading the eye never sees.
test("the op counts stand midway between the dock's rule and the prompt box", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 })
    for (const fixture of ["queue-ops-spacing-fixture.html?agents=1&links=1&watches=1", "drawer-composer-footer-fixture.html"]) {
      await page.goto(`${baseUrl}/${fixture}`, { waitUntil: "networkidle0" })
      await page.evaluate(() => { document.documentElement.dataset.font = "sans" })
      await page.waitForSelector("[data-queue-ops-summary] [data-ops-count]")
      const bands = await page.$eval("[data-queue-ops-summary]", (summary) => {
        const bar = summary.parentElement!
        let ruled: HTMLElement = bar
        while (parseFloat(getComputedStyle(ruled).borderTopWidth) === 0) ruled = ruled.parentElement!
        const rule = ruled.getBoundingClientRect().top + parseFloat(getComputedStyle(ruled).borderTopWidth)
        const box = bar.querySelector<HTMLElement>(".group.relative.rounded-xl")!.getBoundingClientRect().top
        return [...summary.querySelectorAll<HTMLElement>("[data-ops-count]")].map((count) => {
          const label = count.lastElementChild as HTMLElement
          // A zero-size inline-block's bottom edge is the baseline of the inline context it sits in.
          const probe = document.createElement("span")
          probe.style.cssText = "display:inline-block;width:0;height:0"
          label.appendChild(probe)
          const baseline = probe.getBoundingClientRect().bottom
          probe.remove()
          const style = getComputedStyle(label)
          const canvas = document.createElement("canvas").getContext("2d")!
          canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
          const cap = canvas.measureText("H").actualBoundingBoxAscent
          return { above: baseline - cap - rule, below: box - baseline, gap: box - rule }
        })
      })
      assert.ok(bands.length > 0)
      for (const band of bands) {
        assert.equal(band.gap, 32, `${fixture}: the prompt box stands 32px under the rule`)
        assert.ok(Math.abs(band.above - band.below) < 0.5, `${fixture}: ${band.above.toFixed(2)}px above the counts against ${band.below.toFixed(2)}px below`)
      }
    }
  } finally {
    await browser.close()
  }
})
