import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the GitHub picker's header — the repo slug as right-justified text linking
// out — and the footer gear beside the Start button, whose modal panel holds the model and the prompt. Drives
// github-picker-range-fixture, which
// records every settingsSet the popover makes. Skipped unless FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL names
// a vite serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL

type Fixture = { settingsWrites: Record<string, unknown>[]; dispatched: unknown[]; preferenceWrites: unknown[] }
const GEAR = 'button[aria-label="Investigation settings"]'
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

test("the header links out to the repo as right-justified text, rules frame the body, and the footer is the running count, the gear and the Start button", { skip: !baseUrl, timeout: 60_000 }, async () => {
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
        glyphs: link.querySelectorAll("svg").length,
        titleGlyphs: title.querySelectorAll("svg").length + (h2.firstElementChild?.tagName === "svg" ? 1 : 0),
        hasGear: h2.querySelector('button[aria-label="Investigation settings"]') !== null,
        linkRight: link.getBoundingClientRect().right,
        listRight: document.querySelector("[data-row-number]")!.parentElement!.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
        dash: /—/.test(h2.textContent ?? ""),
        border: style.borderTopWidth,
        background: style.backgroundColor,
        color: style.color,
      }
    })
    assert.equal(header.href, "https://github.com/fixture/repo")
    assert.equal(header.target, "_blank")
    assert.equal(header.text, "fixture/repo")
    assert.equal(header.title, "Start threads from issues and PRs")
    assert.equal(header.glyphs, 2, "the GitHub mark and the external arrow are both the link's")
    assert.equal(header.titleGlyphs, 0, "the mark moved off the title")
    assert.equal(header.dash, false, "the slug is no longer an em-dashed suffix of the title")
    assert.equal(header.hasGear, false, "the gear lives in the footer")
    assert.ok(Math.abs(header.listRight - header.linkRight) < 1, `the link ends on the list's right edge, got ${header.linkRight} vs ${header.listRight}`)
    assert.ok(header.linkRight - header.titleRight > 100, "the link is right-justified, well clear of the title")
    assert.equal(header.border, "0px", "the link is text, not a box stacked on the sort control")
    assert.equal(header.background, "rgba(0, 0, 0, 0)", "and has no fill")
    // fg at 85%: brighter than any muted tone, a step under the title's own fg.
    const alpha = Number(/\/\s*([\d.]+)\)$/.exec(header.color)?.[1] ?? 1)
    assert.ok(alpha > 0.8 && alpha < 0.9, `the link is drawn in the fg tone, got ${header.color}`)

    // One rule under the heading and one over the footer, each edge to edge across the modal.
    const rules = await page.evaluate(() => {
      const h2 = document.querySelector("h2")!
      const modal = h2.parentElement!
      const startButton = [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))!
      const footer = startButton.parentElement!.parentElement!
      const inner = modal.getBoundingClientRect()
      const read = (el: Element, side: "Top" | "Bottom") => {
        const box = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return { width: style[`border${side}Width`], color: style[`border${side}Color`], left: box.left - inner.left, right: inner.right - box.right }
      }
      const start = startButton.getBoundingClientRect()
      return {
        heading: read(h2, "Bottom"),
        footer: read(footer, "Top"),
        aboveStart: start.top - footer.getBoundingClientRect().top - 1,
        belowStart: inner.bottom - 1 - start.bottom,
      }
    })
    assert.equal(rules.heading.width, "1px", "a rule under the heading")
    assert.equal(rules.footer.width, "1px", "a rule above the footer")
    assert.equal(rules.heading.color, rules.footer.color, "the two rules are one tone")
    assert.equal(rules.aboveStart, 12, "12px between the footer's rule and the Start button")
    assert.equal(rules.belowStart, 12, "and 12px between the button and the modal's bottom edge")
    for (const rule of [rules.heading, rules.footer]) {
      assert.ok(rule.left <= 1 && rule.right <= 1, `the rule runs edge to edge, got ${rule.left} / ${rule.right} of inset`)
    }

    // The footer is one row. The gear is the Start button's left-hand neighbour: INK, not boxes, because
    // its hover square carries the glyph's dead space. The model selector is not on it.
    const footer = await page.evaluate((gearSelector) => {
      const gear = document.querySelector<HTMLButtonElement>(gearSelector)!
      const start = [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))!
      const ink = [...gear.querySelectorAll("svg *")].map((g) => g.getBoundingClientRect())
      const startBox = start.getBoundingClientRect()
      const row = start.parentElement!.parentElement!
      return {
        sameCluster: gear.parentElement === start.parentElement,
        gearInkRight: Math.max(...ink.map((r) => r.right)),
        gearInkMid: (Math.min(...ink.map((r) => r.top)) + Math.max(...ink.map((r) => r.bottom))) / 2,
        startLeft: startBox.left,
        startMid: (startBox.top + startBox.bottom) / 2,
        rowText: row.textContent ?? "",
        modelSelector: document.querySelector('[aria-label="Model and effort"]') !== null,
        rowAboveRule: row.previousElementSibling === document.querySelector("[data-row-number]")!.parentElement,
      }
    }, GEAR)
    assert.ok(footer.sameCluster, "the gear and the Start button are one cluster")
    const air = footer.startLeft - footer.gearInkRight
    assert.ok(air > 12 && air < 17, `the gear's ink stands ~14.5px left of the button, got ${air}px`)
    assert.ok(Math.abs(footer.gearInkMid - footer.startMid) < 0.75, `the gear is centred on the button, off by ${footer.gearInkMid - footer.startMid}px`)
    assert.match(footer.rowText, /5 open issues/, "the running count shares the footer's row")
    assert.equal(footer.rowAboveRule, true, "nothing stands between the list and the footer")
    assert.equal(footer.modelSelector, false, "the model selector is in the panel, not on the footer")

    // The panel opens UPWARD from the modal's bottom edge. Polled, not read once: it slides in, and
    // its first frame stands ~290px below where it settles.
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    assert.equal(await page.$eval(PANEL, (el) => (el as HTMLElement).dataset.side), "top")
    await page.waitForFunction((panel, gearSelector) =>
      document.querySelector(panel)!.getBoundingClientRect().bottom <= document.querySelector(gearSelector)!.getBoundingClientRect().top,
    { timeout: 2000 }, PANEL, GEAR)
    // And back across the picker from its right edge: the panel ends where the Start button does, and
    // stays inside the picker's content edges (anchored to the gear, it once stood 22px past the left one).
    const edges = await page.evaluate((panel) => {
      const box = document.querySelector(panel)!.getBoundingClientRect()
      const start = [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))!.getBoundingClientRect()
      const list = document.querySelector("[data-row-number]")!.parentElement!.getBoundingClientRect()
      return { left: box.left, right: box.right, startRight: start.right, listLeft: list.left }
    }, PANEL)
    assert.ok(Math.abs(edges.right - edges.startRight) < 1, `the panel's right edge is the Start button's, got ${edges.right} vs ${edges.startRight}`)
    assert.ok(edges.left >= edges.listLeft - 0.5, `the panel stays inside the picker, got ${edges.left} vs the list's ${edges.listLeft}`)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// The grid is a menu inside a modal popover, and its per-runtime gear opens a panel from inside that menu:
// three layers, each portaled to <body>. What only a real browser settles is who paints on top, who gets
// the click, and that one Escape unwinds one layer.
test("a native OpenCode profile reads as experimental in the panel and on the menu's OpenCode heading, in sentence case", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?rows=5&opencode=1")
  const SELECTOR = `${PANEL} [aria-label="Model and effort"]`
  const chip = (scope: string) => page.$eval(`${scope} [data-experimental-chip]`, (el) => ({ text: el.textContent, caps: getComputedStyle(el).fontVariantCaps }))
  try {
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} [data-experimental-chip]`)
    assert.deepEqual(await chip(PANEL), { text: "Experimental", caps: "normal" })
    await page.click(SELECTOR)
    await page.waitForSelector(".profile-grid-menu")
    assert.deepEqual(await chip(".profile-grid-menu"), { text: "Experimental", caps: "normal" })

    // OpenCode's models are a dropdown under its heading, not rows of the grid, and a pick saves the model.
    // The saved bare `opencode:` reads as the model OpenCode's config picks, by name, and the panel's
    // trigger leads with OpenCode and sets that name in the edition ink.
    assert.equal(await page.$eval('[aria-label="OpenCode model"]', (el) => el.textContent), "Big Pickle")
    assert.deepEqual(await page.$eval(SELECTOR, (el) => ({ text: el.textContent, edition: el.querySelector(".profile-grid-edition")?.textContent })), { text: "OpenCode Big Pickle", edition: "Big Pickle" })
    await page.hover('[aria-label="OpenCode model"]')
    await page.click('[aria-label="OpenCode model"]')
    await page.waitForFunction(() => [...document.querySelectorAll('.profile-grid-submenu [role="menuitemradio"]')].some((el) => el.textContent === "Flint 40B Free"), { timeout: 10_000 })
    await page.evaluate(() => [...document.querySelectorAll('.profile-grid-submenu [role="menuitemradio"]')].find((el) => el.textContent === "Flint 40B Free")!.setAttribute("data-pick", ""))
    await page.click(".profile-grid-submenu [data-pick]")
    await page.waitForFunction(() => !document.querySelector(".profile-grid-menu"), { timeout: 5000 })
    const writes = await page.evaluate(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.preferenceWrites)
    assert.deepEqual(writes.at(-1), { field: "profile", backend: "opencode", model: "opencode:opencode/flint-40b-free" })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("an ACP agent is a group of its own in the menu, under its name, and its model dropdown saves the agent's model", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?rows=5&acp=1")
  const SELECTOR = `${PANEL} [aria-label="Model and effort"]`
  try {
    await page.click(GEAR)
    await page.waitForSelector(SELECTOR)
    await page.click(SELECTOR)
    await page.waitForSelector('.profile-grid-menu [data-profile-grid-dropdowns="acp:cursor"]')
    // The list is read once the dropdown opens; until then the band names the agent's configured model.
    assert.equal(await page.$eval('[aria-label="Cursor model"]', (el) => el.textContent), "Configured model")
    assert.equal(await page.$('[aria-label="Cursor reasoning level"]'), null, "an agent has no level to choose")
    await page.hover('[aria-label="Cursor model"]')
    await page.click('[aria-label="Cursor model"]')
    await page.waitForFunction(() => [...document.querySelectorAll('.profile-grid-submenu [role="menuitemradio"]')].some((el) => el.textContent === "GPT-5.5"), { timeout: 10_000 })
    assert.deepEqual(await page.$$eval('.profile-grid-submenu [role="menuitemradio"]', (els) => els.map((el) => el.textContent)), ["Auto", "GPT-5.5", "Sonnet 5"])
    await page.evaluate(() => [...document.querySelectorAll('.profile-grid-submenu [role="menuitemradio"]')].find((el) => el.textContent === "GPT-5.5")!.setAttribute("data-pick", ""))
    await page.click(".profile-grid-submenu [data-pick]")
    await page.waitForFunction(() => !document.querySelector(".profile-grid-menu"), { timeout: 5000 })
    const writes = await page.evaluate(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.preferenceWrites)
    assert.deepEqual(writes.at(-1), { field: "profile", backend: "acp", model: "acp:cursor@gpt-5.5" })
    // Nothing beside the selector: the agent's model is the menu's, not a second pill's.
    assert.equal(await page.$(`${PANEL} [aria-label^="Model for"]`), null)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the model selector works from inside the settings panel: its menu and the runtime panel paint on top, a pick saves, and Escape unwinds one layer at a time", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page, errors } = await launch()
  const SELECTOR = `${PANEL} [aria-label="Model and effort"]`
  const MENU = ".profile-grid-menu"
  const RUNTIME_PANEL = "[data-agent-settings-menu]"
  const onTop = (selector: string) => page.evaluate((sel) => {
    const el = document.querySelector(sel)!
    const box = el.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return el.contains(hit)
  }, selector)
  const settled = (selector: string) => page.waitForFunction((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const box = el.getBoundingClientRect()
    return box.width > 0 && el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
  }, { timeout: 4000 }, selector)
  const gone = (selector: string) => page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 3000 }, selector)
  const preferenceWrites = () => page.evaluate(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.preferenceWrites.length)
  try {
    await page.click(GEAR)
    await page.waitForSelector(SELECTOR)

    // Opening focuses the panel, not the selector, so nothing on it draws a focus ring.
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(await page.evaluate((panel) => document.activeElement === document.querySelector(panel), PANEL), true, "the panel holds the focus")

    // The selector names the edition, as it does everywhere else, and is drawn as a field: the input's dark
    // fill against the panel's, not a transparent trigger that disappears into it. No label stands over it.
    const trigger = await page.$eval(SELECTOR, (el) => ({
      edition: el.querySelector(".profile-grid-edition")?.textContent,
      fill: getComputedStyle(el).backgroundColor,
      boxFill: getComputedStyle(el.closest("[data-github-prompt-menu]")!.querySelector("textarea")!.parentElement!).backgroundColor,
      panelFill: getComputedStyle(el.closest("[data-github-prompt-menu]")!).backgroundColor,
      // The panel is a header and a body; the body's first row is the selector itself.
      first: el.closest("[data-github-prompt-menu]")!.firstElementChild!.lastElementChild!.firstElementChild!.contains(el),
    }))
    assert.equal(trigger.edition, "5.5")
    assert.equal(trigger.fill, trigger.boxFill, "the selector wears the prompt box's fill")
    assert.notEqual(trigger.fill, trigger.panelFill, "which is not the panel's")
    assert.equal(trigger.first, true, "nothing stands above the selector in the panel's body")

    // The menu paints over the panel it opened from, and a pick lands without closing the panel.
    await page.click(SELECTOR)
    await settled(MENU)
    assert.equal(await onTop(MENU), true, "the model menu paints over the settings panel")
    await page.click(`${MENU} [role="menuitemradio"][aria-checked="false"]`)
    await gone(MENU)
    assert.equal(await preferenceWrites(), 1, "the pick saved")
    assert.ok(await page.$(PANEL), "picking a model leaves the settings panel open")

    // The runtime gear's panel lands over the menu that opened it.
    await page.click(SELECTOR)
    await settled(MENU)
    await page.click(`${MENU} .agent-settings-trigger`)
    await settled(RUNTIME_PANEL)
    assert.equal(await onTop(RUNTIME_PANEL), true, "the runtime settings panel paints over the model menu")

    // One Escape, one layer: the runtime panel, the menu, the settings panel, and the picker stays.
    await page.keyboard.press("Escape")
    await gone(RUNTIME_PANEL)
    assert.ok(await page.$(MENU), "the first Escape closed only the runtime panel")
    await page.keyboard.press("Escape")
    await gone(MENU)
    assert.ok(await page.$(PANEL), "the second Escape closed only the menu")
    await page.keyboard.press("Escape")
    await gone(PANEL)
    assert.ok(await page.$("h2"), "the third closed the settings panel, and the picker is still open")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on a phone the header and the controls stay inside the picker's content edges", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    await page.waitForFunction(() => {
      const label = [...document.querySelectorAll("span")].find((s) => s.textContent?.trim() === "Sort")
      return !label || getComputedStyle(label).display === "none"
    }, { timeout: 5000 })
    const edges = await page.evaluate(() => {
      const list = document.querySelector("[data-row-number]")!.parentElement!.getBoundingClientRect()
      const pressed = [...document.querySelectorAll('button[aria-pressed]')].filter((b) => !(b as HTMLElement).dataset.rowNumber)
      const sort = pressed.find((b) => b.textContent?.trim() === "Recent")!.parentElement!.getBoundingClientRect()
      const link = document.querySelector("a.github-repo-link")!.getBoundingClientRect()
      return { listRight: list.right, sortRight: sort.right, linkRight: link.right }
    })
    assert.ok(edges.sortRight <= edges.listRight + 0.5, `the sort control stays inside the list's edge, got ${edges.sortRight} vs ${edges.listRight}`)
    assert.ok(Math.abs(edges.linkRight - edges.listRight) < 1, `the repo link ends on the list's edge, got ${edges.linkRight} vs ${edges.listRight}`)

    // Once something is checked the running count takes the footer's left side from the repo total.
    await page.click("[data-row-number]", { offset: { x: 14, y: 14 } })
    await page.waitForFunction(() => /1 selected/.test(document.body.innerText), { timeout: 3000 })
    assert.doesNotMatch(await page.$eval("body", (b) => b.innerText), /open issues/, "the total gives way on a phone")

    // The phone's model control is a bottom sheet, and it has to open over the settings panel.
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} [aria-label="Model and effort"]`)
    await page.click(`${PANEL} [aria-label="Model and effort"]`)
    await page.waitForFunction((panel) => {
      const sheet = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((el) => !el.matches(panel))
      if (!sheet) return false
      const box = sheet.getBoundingClientRect()
      return box.height > 0 && sheet.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    }, { timeout: 4000 }, PANEL)
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

// The tokens are chips under the box that insert themselves, not a list behind a second popover. A chip
// keeps the box's focus and caret, so a token lands where the caret was, and before the caret has ever
// been placed it lands at the end of the prompt rather than at offset 0.
test("a token chip inserts its token at the caret, appends before the caret is placed, and explains itself on hover", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  const chip = (token: string) => `${PANEL} [data-github-prompt-tokens] button[aria-label^="Insert {${token}}"]`
  const value = () => page.$eval(`${PANEL} textarea`, (el) => (el as HTMLTextAreaElement).value)
  try {
    await page.click(GEAR)
    await page.waitForSelector(chip("title"))
    const before = await value()
    assert.deepEqual(
      await page.$$eval(`${PANEL} [data-github-prompt-tokens] button`, (buttons) => buttons.map((b) => b.textContent)),
      ["{repo}", "{n}", "{title}", "{url}", "{labels}", "{body}"],
    )
    assert.ok(!(await page.$$eval(`${PANEL} button`, (buttons) => buttons.some((b) => b.textContent?.trim() === "Tokens"))), "no Tokens popover trigger")

    // Untouched box: the token goes at the end.
    await page.click(chip("labels"))
    assert.equal(await value(), `${before}{labels}`)
    assert.equal(await page.evaluate((panel) => document.activeElement === document.querySelector(`${panel} textarea`), PANEL), true, "the box has the focus")

    // A placed caret: the token goes there, and the caret follows it.
    await page.evaluate((panel) => document.querySelector<HTMLTextAreaElement>(`${panel} textarea`)!.setSelectionRange(0, 0), PANEL)
    await page.click(chip("n"))
    assert.equal(await value(), `{n}${before}{labels}`)
    assert.equal(await page.$eval(`${PANEL} textarea`, (el) => (el as HTMLTextAreaElement).selectionStart), 3)

    // An inserted token saves as typing does, through the debounced write.
    await page.waitForFunction((expected) => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.at(-1)?.githubPrompt === expected, { timeout: 3000 }, `{n}${before}{labels}`)

    await page.hover(chip("body"))
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tooltip"]')].some((el) => /description, shortened if long/.test(el.textContent ?? "")), { timeout: 3000 })
    assert.ok(await page.$(PANEL), "the settings panel is still the only panel open")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
