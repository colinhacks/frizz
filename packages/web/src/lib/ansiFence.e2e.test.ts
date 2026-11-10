import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_ANSI_FENCE_E2E_URL to its origin, e.g.
//   FRIZZ_ANSI_FENCE_E2E_URL=http://localhost:5731 nub run test packages/web/src/lib/ansiFence.e2e.test.ts
const baseUrl = process.env.FRIZZ_ANSI_FENCE_E2E_URL

// lib/ansi.test.ts pins the markup. What only a browser can say is whether that markup survives the
// sanitizer (its classes, and the one inline style it admits), whether the stylesheet turns the classes
// into the theme's terminal palette, and whether the hidden escape spans split the two copy gestures
// the way lib/ansi.ts promises: the button copies the source, a mouse selection copies what is drawn.
test("an ansi fence draws the theme's terminal palette and copies its source", {
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

    // NOTE: no named function expressions in evaluate. Nub's transpiler adds a `__name` keep-names shim
    // that does not exist inside the page.
    const read = () => page.evaluate(() => {
      const color = (selector: string, prop: "color" | "backgroundColor" = "color") => {
        const el = document.querySelector(selector)
        return el ? getComputedStyle(el)[prop] : null
      }
      const codes = [...document.querySelectorAll<HTMLElement>("[data-case] pre code")]
      return {
        languages: codes.map((code) => code.className),
        red: color("[data-case=palette] .ansi-fg-red"),
        brightBlueBg: color("[data-case=palette] .ansi-bg-bright-blue", "backgroundColor"),
        orange: [...document.querySelectorAll<HTMLElement>("[data-case=extended] span[style]")]
          .find((span) => span.textContent === "orange 208")?.style.color ?? null,
        styled: document.querySelectorAll("[data-case=extended] span[style]").length,
        escHidden: [...document.querySelectorAll(".ansi-esc")].every((el) => getComputedStyle(el).display === "none"),
        escCount: document.querySelectorAll(".ansi-esc").length,
        // innerText is the rendered text: no introducer of any spelling may be drawn.
        drawnLeak: codes.some((code) => /\\e\[|�\[|\x1b/.test(code.innerText)),
        inverseFg: color("[data-case=attrs] .ansi-fg-inverse"),
        inverseBg: color("[data-case=attrs] .ansi-bg-inverse", "backgroundColor"),
        blockFg: color("[data-case=attrs] pre code"),
        blockBg: color("[data-case=attrs] pre", "backgroundColor"),
        bold: getComputedStyle(document.querySelector("[data-case=attrs] .ansi-bold")!).fontWeight,
        replaced: document.querySelector<HTMLElement>("[data-case=replaced] pre code")!.innerText,
      }
    })

    await page.goto(`${baseUrl}/ansi-fence-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-case=attrs] .md-code-copy")
    const dark = await read()
    assert.ok(dark.languages.every((name) => name === "hljs language-ansi"), "every case is an ansi fence")
    // --terminal-red / --terminal-bright-blue in theme.css's dark block.
    assert.equal(dark.red, "rgb(204, 0, 0)")
    assert.equal(dark.brightBlueBg, "rgb(114, 159, 207)")
    // The one inline style the sanitizer admits survived it, and draws.
    assert.ok(dark.styled > 40, "the 256-colour and 24-bit cases keep their inline hex")
    assert.equal(dark.orange, "rgb(255, 135, 0)")
    assert.ok(dark.escCount > 50)
    assert.equal(dark.escHidden, true)
    assert.equal(dark.drawnLeak, false)
    // What the Claude runtime delivers for a raw ESC draws as plain coloured text.
    assert.match(dark.replaced, /^commit 6c7dcb78\ndiff --git/)
    // Inverse on default colours borrows the block's own pair.
    assert.equal(dark.inverseBg, dark.blockFg)
    assert.equal(dark.inverseFg, dark.blockBg)
    assert.equal(dark.bold, "700")

    // The same fence re-themes with the app, the way a terminal profile would.
    await page.goto(`${baseUrl}/ansi-fence-fixture.html?theme=light`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-case=attrs] .md-code-copy")
    const light = await read()
    assert.equal(light.red, "rgb(207, 34, 46)")
    assert.equal(light.brightBlueBg, "rgb(5, 80, 174)")
    assert.equal(light.orange, "rgb(255, 135, 0)", "an author-pinned colour does not re-theme")
    assert.equal(light.inverseBg, light.blockFg)
    assert.equal(light.inverseFg, light.blockBg)

    // A mouse selection copies what is drawn…
    const selected = await page.evaluate(() => {
      const code = document.querySelector("[data-case=written] pre code")!
      const range = document.createRange()
      range.selectNodeContents(code)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return selection.toString()
    })
    assert.ok(selected.startsWith("✔ parses the config (3ms)\n"), JSON.stringify(selected.slice(0, 80)))
    assert.ok(!selected.includes("\\e["))

    // …and the copy button copies the source, escapes and all.
    const source = await page.$eval("[data-case=written] pre code", (code) => code.textContent ?? "")
    await page.hover("[data-case=written] .md-code")
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-case=written] .md-code-copy")!).opacity === "1")
    await page.click("[data-case=written] .md-code-copy")
    await page.waitForFunction(() => document.querySelector("[data-case=written] .md-code-copy")!.classList.contains("is-copied"))
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    assert.equal(clipboard, source.replace(/\n$/, ""))
    assert.ok(clipboard.startsWith("\\e[1m\\e[32m✔\\e[0m parses the config"), clipboard.slice(0, 60))

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
