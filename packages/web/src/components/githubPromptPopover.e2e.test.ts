import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the GitHub picker's header — the repo slug as a right-justified chip linking
// out — and the footer gear beside the model chip that opens the triage prompt in a modal popover. Drives
// github-picker-range-fixture, which
// records every settingsSet the popover makes. Skipped unless FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL names
// a vite serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL

type Fixture = { settingsWrites: Record<string, unknown>[]; dispatched: unknown[] }
const GEAR = 'button[aria-label="Triage prompt settings"]'
const PANEL = "[data-github-prompt-menu]"

async function launch(query = "?rows=5") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/github-picker-range-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-row-number]")
  return { browser, page, errors }
}

const writes = (page: import("puppeteer").Page) =>
  page.evaluate(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.map((w) => ({ ...w })))

async function selectAllInTextarea(page: import("puppeteer").Page) {
  await page.focus(`${PANEL} textarea`)
  await page.evaluate((panel) => {
    const box = document.querySelector<HTMLTextAreaElement>(`${panel} textarea`)!
    box.setSelectionRange(0, box.value.length)
  }, PANEL)
}

test("the header links out to the repo from a right-justified chip; the gear stands beside the model chip, the Start button alone on the right", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const header = await page.$eval("h2", (h2) => {
      const link = h2.querySelector<HTMLAnchorElement>("a.github-repo-link")!
      const title = h2.querySelector("span")!
      const style = getComputedStyle(link)
      return {
        href: link.href,
        target: link.target,
        text: link.textContent?.trim(),
        title: title.textContent?.trim(),
        hasArrow: link.querySelector("svg") !== null,
        hasGear: h2.querySelector('button[aria-label="Triage prompt settings"]') !== null,
        linkRight: link.getBoundingClientRect().right,
        h2Right: h2.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
        dash: /—/.test(h2.textContent ?? ""),
        border: style.borderTopWidth,
        color: style.color,
        titleColor: getComputedStyle(title).color,
      }
    })
    assert.equal(header.href, "https://github.com/fixture/repo")
    assert.equal(header.target, "_blank")
    assert.equal(header.text, "fixture/repo")
    assert.equal(header.title, "Start threads from issues and PRs")
    assert.equal(header.hasArrow, true)
    assert.equal(header.dash, false, "the slug is no longer an em-dashed suffix of the title")
    assert.equal(header.hasGear, false, "the gear lives in the footer")
    assert.ok(header.h2Right - header.linkRight < 1, "the chip ends at the header's right edge")
    assert.ok(header.linkRight - header.titleRight > 100, "the chip is right-justified, well clear of the title")
    assert.equal(header.border, "1px", "the link is a bordered chip, not a caption")
    // fg at 85%: brighter than any muted tone, a step under the title's own fg.
    const alpha = Number(/\/\s*([\d.]+)\)$/.exec(header.color)?.[1] ?? 1)
    assert.ok(alpha > 0.8 && alpha < 0.9, `the chip is drawn in the fg tone, got ${header.color}`)

    // The gear is the model chip's right-hand neighbour, as the composer's marks are: INK, not boxes,
    // because its hover square carries the glyph's dead space. The Start button stands alone.
    const footer = await page.evaluate((gearSelector) => {
      const gear = document.querySelector<HTMLButtonElement>(gearSelector)!
      const chip = document.querySelector<HTMLElement>("[data-prompt-control-group]")!
      const start = [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))!
      const ink = [...gear.querySelectorAll("svg *")].map((g) => g.getBoundingClientRect())
      const chipBox = chip.getBoundingClientRect()
      const startBox = start.getBoundingClientRect()
      const inkTop = Math.min(...ink.map((r) => r.top))
      const inkBottom = Math.max(...ink.map((r) => r.bottom))
      return {
        startSiblings: start.parentElement!.children.length,
        gearInkLeft: Math.min(...ink.map((r) => r.left)),
        gearInkRight: Math.max(...ink.map((r) => r.right)),
        gearInkMid: (inkTop + inkBottom) / 2,
        gearInkHeight: inkBottom - inkTop,
        chipRight: chipBox.right,
        chipMid: (chipBox.top + chipBox.bottom) / 2,
        startLeft: startBox.left,
        startMid: (startBox.top + startBox.bottom) / 2,
      }
    }, GEAR)
    const air = footer.gearInkLeft - footer.chipRight
    assert.ok(air > 10 && air < 14, `the gear's ink stands ~12px right of the model chip, as the composer's marks do, got ${air}px`)
    assert.ok(Math.abs(footer.gearInkMid - footer.chipMid) < 0.75, `the gear is centred on the chip, off by ${footer.gearInkMid - footer.chipMid}px`)
    assert.ok(Math.abs(footer.chipMid - footer.startMid) < 0.75, `the chip is centred on the Start button, off by ${footer.chipMid - footer.startMid}px`)
    assert.ok(footer.startLeft - footer.gearInkRight > 200, "the Start button stands well clear of the gear, on the far right")
    assert.equal(footer.startSiblings, 2, "the footer is two things: the chip's cluster, and the Start button")

    // The panel opens UPWARD from the modal's bottom edge. Polled, not read once: it slides in, and
    // its first frame stands ~290px below where it settles.
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    assert.equal(await page.$eval(PANEL, (el) => (el as HTMLElement).dataset.side), "top")
    await page.waitForFunction((panel, gearSelector) =>
      document.querySelector(panel)!.getBoundingClientRect().bottom <= document.querySelector(gearSelector)!.getBoundingClientRect().top,
    { timeout: 2000 }, PANEL, GEAR)
    // And rightward from the gear: it is anchored at the modal's left, so it opens over the list.
    const [panelLeft, gearLeft] = await page.evaluate((panel, gearSelector) =>
      [document.querySelector(panel)!.getBoundingClientRect().left, document.querySelector(gearSelector)!.getBoundingClientRect().left], PANEL, GEAR)
    assert.ok(Math.abs(panelLeft - gearLeft) < 2, `the panel's left edge is the gear's, got ${panelLeft} vs ${gearLeft}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the prompt panel shows the effective prompt, survives the pointer leaving, and debounces typing to one write", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    assert.match(await page.$eval(`${PANEL} textarea`, (el) => (el as HTMLTextAreaElement).value), /^Triage \{repo\}#\{n\}/, "prefilled with the shipped default")
    await page.mouse.move(8, 8, { steps: 10 })
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(await page.$(PANEL), "the panel is still open after the pointer left it")

    await selectAllInTextarea(page)
    await page.keyboard.type("Custom prompt", { delay: 30 })
    assert.equal((await writes(page)).length, 0, "nothing written while typing continues")
    await page.waitForFunction(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.length === 1, { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 600))
    const sent = await writes(page)
    assert.equal(sent.length, 1, "one write for a burst of typing")
    assert.equal(sent[0]!.githubPrompt, "Custom prompt")
    assert.equal(sent[0]!.notifications, true, "the whole object goes over")
    assert.match(await page.$eval(PANEL, (el) => el.textContent ?? ""), /Reset to default/, "a customized prompt offers its reset")

    // Escape closes the panel and ONLY the panel — the picker's own Escape handler closes the whole
    // modal, and it must not see this press.
    await page.keyboard.press("Escape")
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$("h2"), "the picker is still open")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("closing the panel by clicking outside flushes a pending keystroke, closes nothing else, and holds dispatch until the write lands", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?rows=5&settingsDelay=1500")
  try {
    // A row is checked, so the dispatch button is live and its gating is observable.
    await page.click("[data-row-number]")
    const startButton = async () => page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))!)
    assert.equal(await (await startButton()).evaluate((b) => (b as HTMLButtonElement).disabled), false)

    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    await selectAllInTextarea(page)
    await page.keyboard.type("Flushed", { delay: 10 })
    assert.equal((await writes(page)).length, 0, "still inside the debounce")
    // Outside click: the panel's own dismiss. The picker's backdrop would close the picker on a
    // mousedown that reached it — it must not, because the modal panel owns the pointer.
    await page.mouse.click(8, 8)
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$("h2"), "the picker survived the outside click")
    // The flushed write is in flight for 1.5s: the button waits on it.
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))?.disabled === true, { timeout: 2000 })
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))?.disabled === false, { timeout: 5000 })
    const sent = await writes(page)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.githubPrompt, "Flushed", "the half-typed value survived the close")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// The picker's issue and PR prompts merged into ONE field on 2026-08-15. Two properties of the RENDERED
// panel: there is exactly one editor (a stray second one would mean a per-kind field survived the
// merge), and "Reset to default" clears the override to undefined — the wire value that means "use the
// server default", as opposed to a copy of the default text frozen into the user's settings.
test("one prompt editor, and Reset clears the override rather than freezing the default text", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    assert.equal(await page.evaluate(() => document.querySelectorAll("textarea").length), 1, "one editor, not one per kind")
    const labels = () => page.evaluate((panel) => [...document.querySelectorAll(`${panel} button`)].map((b) => (b.textContent ?? "").trim()), PANEL)
    assert.ok(!(await labels()).includes("Reset to default"), "no Reset while the box shows the shipped default")

    await selectAllInTextarea(page)
    await page.keyboard.type("mine", { delay: 30 })
    await page.waitForFunction(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.length === 1, { timeout: 5000 })
    assert.equal((await writes(page))[0]!.githubPrompt, "mine")

    await page.evaluate((panel) => {
      [...document.querySelectorAll<HTMLButtonElement>(`${panel} button`)].find((b) => b.textContent?.trim() === "Reset to default")!.click()
    }, PANEL)
    await page.waitForFunction(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.length === 2, { timeout: 5000 })
    const sent = await writes(page)
    assert.equal(sent[1]!.githubPrompt, undefined, "cleared to unset, which is what the server reads as 'default'")
    assert.ok(!("githubIssuePrompt" in sent[1]!), "the merged-away key never reappears on the wire")
    assert.ok(!("githubPrPrompt" in sent[1]!))
    assert.match(await page.$eval(`${PANEL} textarea`, (el) => (el as HTMLTextAreaElement).value), /^Triage \{repo\}/, "the box shows the shipped default again")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
