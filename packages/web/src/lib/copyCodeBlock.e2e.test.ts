import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_CODE_COPY_E2E_URL to its origin, e.g.
//   FRIZZ_CODE_COPY_E2E_URL=http://localhost:5731 nub run test packages/web/src/lib/copyCodeBlock.e2e.test.ts
const baseUrl = process.env.FRIZZ_CODE_COPY_E2E_URL

// The pieces of this are unit-testable in isolation and that proves nothing: the markup comes out of
// lib/syntaxHighlight.ts, the DOM sanitizer decides whether the wrapper's class and the button survive
// at all, the stylesheet decides whether the button is reachable, and a delegated document listener does
// the copying. The seam between those four is where the whole feature lives, so this drives the shipped
// path in a real browser and reads the REAL system clipboard back.
//
// Clipboard permission has to come through CDP: puppeteer's `overridePermissions("clipboard-write")`
// resolves to `denied` in headless Chrome, and the copy then fails in a way that looks exactly like a
// broken handler — an empty clipboard and no check.
test("a fenced code block copies its own source, minus the renderer's trailing newline", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
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
    await page.setViewport({ width: 1400, height: 1100, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/syntax-highlighting-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector(".md-code-copy")

    // Every fenced block gets one, and the wrapper class survived the sanitizer (without it the button
    // has no positioned ancestor and lands somewhere else entirely).
    const counts = await page.evaluate(() => ({
      blocks: document.querySelectorAll(".md-code").length,
      buttons: document.querySelectorAll(".md-code").length
        && [...document.querySelectorAll(".md-code")].filter((w) => w.querySelector(":scope > .md-code-copy")).length,
      positioned: [...document.querySelectorAll(".md-code")].every((w) => getComputedStyle(w).position === "relative"),
    }))
    assert.ok(counts.blocks > 1, "the fixture should render several fenced blocks")
    assert.equal(counts.buttons, counts.blocks)
    assert.equal(counts.positioned, true)

    // CONCENTRIC CORNERS. The chip is a rounded box inside the block's rounded box, so its arc must
    // share a centre with the block's — inner radius = outer radius − the gap. Pinned because the
    // relationship is derived (`calc(var(--block-radius) - var(--md-copy-inset))`) and a plausible-looking
    // edit to a fixed radius, or to the inset alone, breaks it silently: the band between the two arcs
    // just pinches through the corner. Checked at BOTH prose scales, since the gap is in `em`.
    //
    // The block's rounded box is the `pre` on a plain fence and the WRAPPER on a framed one
    // (lib/codeBlock.ts — the fixture's `title=` fences are titled blocks), where header and code share
    // one frame. The button must be concentric with whichever it is.
    const arcs = await page.evaluate(() => [...document.querySelectorAll(".md-code")].map((wrap) => {
      const framed = wrap.classList.contains("md-code-frame")
      const frame = framed ? wrap : wrap.querySelector("pre")!, btn = wrap.querySelector(".md-code-copy")!
      const radius = (el: Element) => parseFloat(getComputedStyle(el).borderTopRightRadius)
      const gap = frame.getBoundingClientRect().right - btn.getBoundingClientRect().right
      // Each arc's centre, measured in from the same edge.
      return { framed, outer: +radius(frame).toFixed(2), inner: +(gap + radius(btn)).toFixed(2) }
    }))
    assert.ok(arcs.some((arc) => arc.framed) && arcs.some((arc) => !arc.framed), "the fixture should hold both a plain and a titled block")
    for (const { outer, inner } of arcs) assert.ok(Math.abs(outer - inner) < 0.05, `arc centres differ: ${outer} vs ${inner}`)

    // Quiet until hovered, so a transcript full of fences is not a wall of buttons.
    assert.equal(await page.$eval("#thread .md-code-copy", (b) => getComputedStyle(b).opacity), "0")
    await page.hover("#thread .md-code")
    // It fades in over --default-transition-duration, so this cannot be read on the same tick as the hover.
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#thread .md-code-copy")!).opacity === "1")

    const source = await page.$eval("#thread .md-code pre code", (code) => code.textContent ?? "")
    await page.click("#thread .md-code-copy")
    await page.waitForFunction(() => document.querySelector("#thread .md-code-copy")!.classList.contains("is-copied"))

    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    // The renderer appends exactly one LF so a still-streaming fence selects sanely. It must not reach
    // the clipboard: a shell command pasted into a terminal with a trailing newline RUNS.
    assert.match(source, /\n$/)
    assert.equal(clipboard, source.replace(/\n$/, ""))
    assert.ok(clipboard.includes("console.log(next.id)"))
    // highlight.js wraps tokens in <span>s; none of that markup may ride along.
    assert.ok(!clipboard.includes("<span"))

    assert.equal(await page.$eval("#thread .md-code-copy", (b) => (b as HTMLButtonElement).title), "Copied")
    // …and it goes back on its own, so a stale check never claims a copy that has scrolled out of memory.
    await page.waitForFunction(() => !document.querySelector("#thread .md-code-copy")!.classList.contains("is-copied"), { timeout: 5_000 })
    assert.equal(await page.$eval("#thread .md-code-copy", (b) => (b as HTMLButtonElement).title), "Copy code")

    // Each block copies its OWN source — the delegated listener resolves the code through the wrapper,
    // not through document order.
    const second = await page.evaluate(() => {
      const wrap = [...document.querySelectorAll<HTMLElement>("#thread .md-code")]
        .find((w) => /pnpm --filter/.test(w.textContent ?? ""))!
      return { text: wrap.querySelector("pre code")!.textContent!, index: [...document.querySelectorAll("#thread .md-code")].indexOf(wrap) }
    })
    await page.hover(`#thread .md-code:nth-of-type(${second.index + 1})`)
    await page.click(`#thread .md-code:nth-of-type(${second.index + 1}) .md-code-copy`)
    await page.waitForFunction((i: number) => document.querySelectorAll(".md-code-copy")[i]?.classList.contains("is-copied"), {}, second.index)
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), second.text.replace(/\n$/, ""))

    // CODE WRAPS by default, so no block scrolls sideways. The fixture's 455-character token is the
    // case that would: it breaks across lines inside its block, at the thread's width and the Queue's.
    const wrapped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".md-code pre")].map((pre) => {
      const style = getComputedStyle(pre)
      return {
        text: (pre.textContent ?? "").slice(0, 7),
        scrolls: pre.scrollWidth - pre.clientWidth,
        lines: Math.round((pre.clientHeight - parseFloat(style.paddingTop) * 2) / parseFloat(style.lineHeight)),
      }
    }))
    assert.deepEqual(wrapped.filter((pre) => pre.scrolls !== 0), [], "no code block scrolls sideways")
    const longThread = wrapped.find((pre) => pre.text === "thread_")!
    const longQueue = wrapped.find((pre) => pre.text === "queue_0")!
    assert.ok(longThread.lines > 2, `the thread's one long line is drawn on ${longThread.lines}`)
    assert.ok(longQueue.lines > 2, `the Queue's one long line is drawn on ${longQueue.lines}`)

    // THE REASON THE WRAPPER EXISTS. With Wrap code off (lib/codeWrap.ts puts the setting on <html>, and
    // the stylesheet reads it there) the thread's block scrolls sideways instead, and `pre` is the scroll
    // container: a button anchored inside it would ride the content out of view. The Queue's column
    // follows the same setting, and its block scrolls inside itself without widening the column.
    const held = await page.evaluate(() => {
      document.documentElement.dataset.codeWrap = "off"
      const wrap = [...document.querySelectorAll<HTMLElement>("#thread .md-code")]
        .find((w) => { const p = w.querySelector("pre")!; return p.scrollWidth > p.clientWidth + 20 })
      const column = document.querySelector<HTMLElement>("#queue")!
      const queue = {
        scrolling: [...column.querySelectorAll<HTMLElement>(".md-code pre")].filter((p) => p.scrollWidth > p.clientWidth + 20).length,
        spills: column.scrollWidth - column.clientWidth,
      }
      if (!wrap) return { found: false, before: 0, after: 0, scrolled: 0, queue }
      const pre = wrap.querySelector("pre")!, btn = wrap.querySelector(".md-code-copy")!
      const offset = () => +(btn.getBoundingClientRect().right - pre.getBoundingClientRect().right).toFixed(2)
      const before = offset()
      pre.scrollLeft = pre.scrollWidth
      return { found: true, before, after: offset(), scrolled: pre.scrollLeft, queue }
    })
    assert.equal(held.found, true, "with wrapping off the thread's long line should scroll its block")
    assert.ok(held.scrolled > 100, `the block scrolled ${held.scrolled}px`)
    assert.equal(held.after, held.before)
    assert.ok(held.queue.scrolling > 0, "the Queue's long line scrolls its block too")
    assert.equal(held.queue.spills, 0, "and the block stays inside the Queue's column")

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})

// The SAME shipped path with `navigator.clipboard` GONE — not a contrived state: the async clipboard
// API exists only in a secure context, and a Frizz served over `--host` to a LAN address is plain
// http, where every copy affordance used to refuse with "copy the code from a secure Frizz page". The
// fallback selects the text in an off-screen textarea and execCommand("copy")s it, so this shadows the
// API exactly the way an insecure origin removes it, clicks the shipped button inside a real trusted
// gesture, and reads the REAL clipboard back through the un-shadowed API afterwards.
test("the copy still lands when navigator.clipboard is unavailable (insecure origin)", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    const cdp = await browser.target().createCDPSession()
    await cdp.send("Browser.grantPermissions", {
      origin: baseUrl!,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon\.ico|404 \(Not Found\)/.test(m.text())) pageErrors.push(m.text())
    })
    await page.setViewport({ width: 1400, height: 1100, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/syntax-highlighting-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector(".md-code-copy")

    // Shadow the accessor the way an insecure origin removes it. An own configurable property, so
    // `delete` below restores the prototype getter for the read-back.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    })
    assert.equal(await page.evaluate(() => navigator.clipboard === undefined), true)

    const source = await page.$eval("#thread .md-code pre code", (code) => code.textContent ?? "")
    await page.hover("#thread .md-code")
    await page.click("#thread .md-code-copy")
    // The check appears ONLY after a copy the handler believes landed — with writeText gone, that can
    // only be the execCommand path reporting success.
    await page.waitForFunction(() => document.querySelector("#thread .md-code-copy")!.classList.contains("is-copied"))

    const clipboard = await page.evaluate(() => {
      delete (navigator as { clipboard?: unknown }).clipboard
      return navigator.clipboard.readText()
    })
    assert.equal(clipboard, source.replace(/\n$/, ""))

    // The off-screen textarea is a transient instrument: it must not survive the copy, and the page
    // selection must not end up sitting in a box the user cannot see.
    assert.equal(await page.evaluate(() => document.querySelectorAll("textarea").length), 0)

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
