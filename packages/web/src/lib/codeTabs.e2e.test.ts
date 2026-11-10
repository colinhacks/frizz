import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_CODE_TABS_E2E_URL to its origin, e.g.
//   FRIZZ_CODE_TABS_E2E_URL=http://localhost:5731 nub run test packages/web/src/lib/codeTabs.e2e.test.ts
const baseUrl = process.env.FRIZZ_CODE_TABS_E2E_URL

// lib/codeTabs.test.ts pins the grouping and the markup. What only a browser can say is whether that
// markup survives the sanitizer with its roles, whether the stylesheet shows one panel and lines the
// header up with the code, and whether the delegated listeners switch, copy and remember a tab.
test("labelled fences render as tabs that switch, copy the open tab and stay chosen", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    // Clipboard permission has to come through CDP — see copyCodeBlock.e2e.test.ts.
    const cdp = await browser.target().createCDPSession()
    await cdp.send("Browser.grantPermissions", {
      origin: baseUrl!,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    // The fixture declares no favicon, so vite 404s /favicon.ico on every bare fixture page here.
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon\.ico|404 \(Not Found\)/.test(m.text())) pageErrors.push(m.text())
    })
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/code-tabs-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-case=narrow] .md-code-tab")

    // NOTE: no named function expressions in evaluate. Nub's transpiler adds a `__name` keep-names shim
    // that does not exist inside the page.
    const read = (id: string) => page.evaluate((caseId: string) => {
      const root = document.querySelector(`[data-case=${caseId}]`)!
      const group = root.querySelector(".md-code-tabs")
      if (!group) return null
      const list = group.querySelector<HTMLElement>(".md-code-tablist")!
      const tabs = [...group.querySelectorAll<HTMLElement>(".md-code-tab")]
      const panels = [...group.querySelectorAll<HTMLElement>(":scope > pre")]
      const shown = panels.filter((panel) => getComputedStyle(panel).display !== "none")
      const copy = group.querySelector<HTMLElement>(".md-code-copy")!
      const first = group.querySelector<HTMLElement>(".md-code-tab, .md-code-title")!
      const label = document.createRange()
      label.selectNodeContents(first)
      const code = document.createRange()
      code.selectNodeContents(shown[0].querySelector("code")!)
      const row = list.getBoundingClientRect()
      const button = copy.getBoundingClientRect()
      return {
        listRole: list.getAttribute("role"),
        labels: tabs.map((tab) => tab.textContent),
        roles: tabs.map((tab) => tab.getAttribute("role")),
        selected: tabs.map((tab) => tab.getAttribute("aria-selected")),
        active: tabs.findIndex((tab) => tab.classList.contains("is-active")),
        panelRoles: panels.map((panel) => panel.getAttribute("role")),
        shown: shown.length,
        shownIndex: panels.indexOf(shown[0]),
        shownText: shown[0].querySelector("code")!.textContent ?? "",
        title: group.querySelector(".md-code-title")?.textContent ?? null,
        copyButtons: group.querySelectorAll(".md-code-copy").length,
        labelLeft: label.getClientRects()[0].left,
        codeLeft: code.getClientRects()[0].left,
        // The copy button against the row ABOVE its 1px rule, which is the box it is centred in.
        copyOffCentre: (button.top + button.height / 2) - (row.top + (row.height - 1) / 2),
        scrolls: list.scrollWidth > list.clientWidth,
      }
    }, id)

    // The sanitizer kept what the renderer minted: the roles, the classes, one copy button.
    const install = (await read("install"))!
    assert.equal(install.listRole, "tablist")
    assert.deepEqual(install.labels, ["npm", "pnpm", "yarn"])
    assert.deepEqual(install.roles, ["tab", "tab", "tab"])
    assert.deepEqual(install.selected, ["true", "false", "false"])
    assert.deepEqual(install.panelRoles, ["tabpanel", "tabpanel", "tabpanel"])
    assert.equal(install.shown, 1, "only the open tab's panel is displayed")
    assert.equal(install.copyButtons, 1)
    assert.match(install.shownText, /^npm install frizz/)

    // The header lines up with the code under it, at every scale a fence renders at.
    for (const id of ["install", "files", "titled", "list", "card", "chip", "narrow"]) {
      const at = (await read(id))!
      assert.ok(Math.abs(at.labelLeft - at.codeLeft) < 0.5, `${id}: the first label starts on the code's left edge (${at.labelLeft} vs ${at.codeLeft})`)
      assert.ok(Math.abs(at.copyOffCentre) < 0.5, `${id}: the copy button is centred in the header row (${at.copyOffCentre})`)
    }

    // One labelled fence is a title: no tab, no roles, its panel displayed.
    const titled = (await read("titled"))!
    assert.equal(titled.title, "packages/web/src/lib/codeTabs.ts")
    assert.deepEqual(titled.labels, [])
    assert.equal(titled.listRole, null)
    assert.equal(titled.shown, 1)
    // Unlabelled neighbours are still two plain blocks.
    assert.equal(await read("plain"), null)
    assert.equal(await page.$$eval("[data-case=plain] .md-code", (blocks) => blocks.length), 2)

    // A click opens that tab and nothing else changes.
    await page.click("[data-case=install] .md-code-tab:nth-child(2)")
    const clicked = (await read("install"))!
    assert.deepEqual(clicked.selected, ["false", "true", "false"])
    assert.equal(clicked.active, 1)
    assert.equal(clicked.shown, 1)
    assert.equal(clicked.shownIndex, 1)
    assert.match(clicked.shownText, /^pnpm add frizz/)
    // A group with the same labels elsewhere on the page is left as it was: no live sync.
    assert.deepEqual((await read("card"))!.selected, ["true", "false", "false"])

    // The one copy button copies the tab that is open.
    await page.hover("[data-case=install] .md-code")
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-case=install] .md-code-copy")!).opacity === "1")
    await page.click("[data-case=install] .md-code-copy")
    await page.waitForFunction(() => document.querySelector("[data-case=install] .md-code-copy")!.classList.contains("is-copied"))
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "pnpm add frizz\npnpm dlx frizz")

    // Arrow keys step and wrap, Home and End jump; selection follows focus.
    const focused = () => page.evaluate(() => document.activeElement?.textContent ?? null)
    await page.focus("[data-case=install] .md-code-tab:nth-child(2)")
    await page.keyboard.press("ArrowRight")
    assert.equal(await focused(), "yarn")
    assert.equal((await read("install"))!.active, 2)
    await page.keyboard.press("ArrowRight")
    assert.equal(await focused(), "npm", "the last tab wraps to the first")
    await page.keyboard.press("ArrowLeft")
    assert.equal(await focused(), "yarn")
    await page.keyboard.press("Home")
    assert.equal((await read("install"))!.active, 0)
    await page.keyboard.press("End")
    const ended = (await read("install"))!
    assert.equal(ended.active, 2)
    assert.match(ended.shownText, /^yarn add frizz/)

    // A rebuild of the same markdown — a streaming delta, a virtualized remount — opens on the tab that
    // was chosen, and so does every other group with those labels.
    await page.click("[data-rerender]")
    await page.waitForFunction(() => document.querySelector("main")!.getAttribute("data-renders") === "1")
    for (const id of ["install", "card", "chip"]) {
      const rebuilt = (await read(id))!
      assert.equal(rebuilt.active, 2, `${id} reopens on yarn`)
      assert.match(rebuilt.shownText, /^yarn add frizz/)
    }
    // A different set of labels was never chosen from: it is on its first tab.
    assert.equal((await read("list"))!.active, 0)

    // Inside an answer chip a tab is above the chip's stretched button, so the click reaches it.
    const hit = await page.$eval("[data-case=chip] .md-code-tab:nth-child(1)", (tab) => {
      // elementFromPoint answers only inside the viewport, and the chip is below the fold.
      tab.scrollIntoView({ block: "center" })
      const box = tab.getBoundingClientRect()
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === tab
    })
    assert.equal(hit, true)
    await page.click("[data-case=chip] .md-code-tab:nth-child(1)")
    assert.match((await read("chip"))!.shownText, /^npm install frizz/)

    // More tabs than the row holds: the strip scrolls rather than wrapping, and opening a tab that is
    // cut off brings it fully into view.
    const overflow = (await read("overflow"))!
    assert.equal(overflow.labels.length, 9)
    assert.equal(overflow.scrolls, true)
    await page.click("[data-case=overflow] .md-code-tab:nth-child(3)")
    const inView = await page.$eval("[data-case=overflow] .md-code-tab:nth-child(3)", (tab) => {
      const box = tab.getBoundingClientRect()
      const row = tab.parentElement!.getBoundingClientRect()
      return { ok: box.left >= row.left - 0.5 && box.right <= row.right + 0.5, tab: [box.left, box.right], row: [row.left, row.right] }
    })
    assert.equal(inView.ok, true, JSON.stringify(inView))
    assert.equal((await read("overflow"))!.active, 2)

    // A label too long for a tab is cut with an ellipsis and keeps its full text as a tooltip.
    const long = await page.$eval("[data-case=long-label] .md-code-tab:nth-child(1)", (tab) => ({
      cut: tab.scrollWidth > tab.clientWidth,
      title: tab.getAttribute("title"),
    }))
    assert.equal(long.cut, true)
    assert.equal(long.title, "packages/server/src/a/very/deep/directory/tree/that/keeps/going/handler.ts")

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
