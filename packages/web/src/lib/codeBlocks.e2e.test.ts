import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_CODE_BLOCKS_E2E_URL to its origin, e.g.
//   FRIZZ_CODE_BLOCKS_E2E_URL=http://localhost:5731 nub run test packages/web/src/lib/codeBlocks.e2e.test.ts
const baseUrl = process.env.FRIZZ_CODE_BLOCKS_E2E_URL

// lib/codeBlock.test.ts pins what a fence's info string turns into. What only a browser can say is
// whether that markup survives the sanitizer, whether the stylesheet draws a marked line and a diff row
// edge to edge at the height of an ordinary line, whether a long block is actually clamped, and whether
// the delegated listeners open it, keep it open and still copy the source.
test("marked lines, rendered diffs and long blocks draw, copy and open on the shipped path", {
  skip: !baseUrl,
  timeout: 90_000,
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
    await page.goto(`${baseUrl}/code-blocks-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-case=narrow] .md-code-expand")

    const copyOf = async (id: string) => {
      await page.hover(`[data-case=${id}] .md-code`)
      await page.click(`[data-case=${id}] .md-code-copy`)
      await page.waitForFunction((caseId: string) =>
        document.querySelector(`[data-case=${caseId}] .md-code-copy`)!.classList.contains("is-copied"), {}, id)
      return page.evaluate(() => navigator.clipboard.readText())
    }

    // NOTE: no named function expressions in evaluate. Nub's transpiler adds a `__name` keep-names shim
    // that does not exist inside the page.

    // ── Marked lines ──────────────────────────────────────────────────────────────────────────────
    const marked = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>("[data-case=marked] pre")!
      const plain = document.querySelector<HTMLElement>("[data-case=plain] pre")!
      const lines = [...pre.querySelectorAll<HTMLElement>(".md-line")]
      const band = pre.querySelector<HTMLElement>(".md-line.is-marked")!
      const first = document.createRange()
      first.selectNodeContents(lines[0])
      const plainText = document.createRange()
      plainText.selectNodeContents(plain.querySelector("code")!)
      return {
        lines: lines.length,
        marked: lines.map((line, i) => (line.classList.contains("is-marked") ? i + 1 : 0)).filter(Boolean),
        height: pre.getBoundingClientRect().height,
        plainHeight: plain.getBoundingClientRect().height,
        // The band runs border to border; the code inside it starts where a plain block's does.
        bandInset: [band.getBoundingClientRect().left - pre.getBoundingClientRect().left, pre.getBoundingClientRect().right - band.getBoundingClientRect().right],
        textLeft: first.getClientRects()[0].left - pre.getBoundingClientRect().left,
        plainTextLeft: plainText.getClientRects()[0].left - plain.getBoundingClientRect().left,
        bandFill: getComputedStyle(band).backgroundColor,
        lineFill: getComputedStyle(lines[0]).backgroundColor,
      }
    })
    assert.equal(marked.lines, 12)
    assert.deepEqual(marked.marked, [7, 8])
    // The same source drawn a line at a time is exactly as tall as it is drawn plain.
    assert.ok(Math.abs(marked.height - marked.plainHeight) < 0.5, `a lined block is ${marked.height}px, the same code plain is ${marked.plainHeight}px`)
    assert.deepEqual(marked.bandInset.map((px) => Math.round(px)), [1, 1], "the band reaches the block's border on both sides")
    assert.ok(Math.abs(marked.textLeft - marked.plainTextLeft) < 0.5, `code starts at ${marked.textLeft}px, in a plain block at ${marked.plainTextLeft}px`)
    assert.notEqual(marked.bandFill, marked.lineFill)

    // A line longer than the block WRAPS inside it, and its band covers every line it wraps to, border
    // to border. Nothing scrolls sideways.
    const wide = await page.$eval("[data-case=marked-wide] pre", (pre) => {
      const band = pre.querySelector<HTMLElement>(".is-marked")!
      const short = pre.querySelector<HTMLElement>(".md-line:not(.is-marked)")!
      const box = pre.getBoundingClientRect(), bandBox = band.getBoundingClientRect()
      return {
        scrolls: pre.scrollWidth - pre.clientWidth,
        lines: bandBox.height / short.getBoundingClientRect().height,
        bandInset: [bandBox.left - box.left, box.right - bandBox.right],
      }
    })
    assert.equal(wide.scrolls, 0, "a long line wraps rather than scrolling its block")
    assert.ok(wide.lines > 1.9 && Math.abs(wide.lines - Math.round(wide.lines)) < 0.05, `the marked line is drawn on ${wide.lines} lines`)
    assert.deepEqual(wide.bandInset.map((px) => Math.round(px)), [1, 1], "the band of a wrapped line reaches the block's border on both sides")

    // The same on a diff row at the thread's width: it continues under its code, tinted the whole way.
    const wideDiff = await page.$eval("[data-case=diff-wide] pre", (pre) => {
      const del = pre.querySelector<HTMLElement>(".md-diff-del")!, add = pre.querySelector<HTMLElement>(".md-diff-add")!
      const text = del.querySelector<HTMLElement>(".md-diff-text")!
      const lines = [...text.getClientRects()]
      return {
        scrolls: pre.scrollWidth - pre.clientWidth,
        lines: del.getBoundingClientRect().height / add.getBoundingClientRect().height,
        hangs: lines.every((line) => line.left - text.getBoundingClientRect().left > -0.5),
        rowWidth: del.getBoundingClientRect().width,
        innerWidth: pre.clientWidth,
      }
    })
    assert.equal(wideDiff.scrolls, 0)
    assert.ok(wideDiff.lines > 1.9, `the long deleted row is drawn on ${wideDiff.lines} lines`)
    assert.equal(wideDiff.hangs, true, "a wrapped row continues under its code, not under its sign")
    assert.ok(Math.abs(wideDiff.rowWidth - wideDiff.innerWidth) < 1, `the wrapped row's tint spans the block: ${wideDiff.rowWidth}px of ${wideDiff.innerWidth}px`)

    // A title and marks on one fence.
    assert.equal(await page.$eval("[data-case=marked-titled] .md-code-title", (title) => title.textContent), "packages/server/src/retry.ts")
    assert.equal(await page.$$eval("[data-case=marked-titled] .md-line.is-marked", (lines) => lines.length), 2)

    assert.match(await copyOf("marked"), /^export async function retry<T>[\s\S]*\n {6}await sleep\(2 \*\* attempt \* 100\)\n[\s\S]*\n}$/)

    // ── Rendered diffs ────────────────────────────────────────────────────────────────────────────
    const diff = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>("[data-case=diff-ts] pre")!
      const rows = [...pre.querySelectorAll<HTMLElement>(".md-diff-row")]
      const add = pre.querySelector<HTMLElement>(".md-diff-add")!
      const del = pre.querySelector<HTMLElement>(".md-diff-del")!
      const ctx = pre.querySelector<HTMLElement>(".md-diff-ctx")!
      const plain = document.querySelector<HTMLElement>("[data-case=plain] pre")!
      const pitch = (el: HTMLElement) => el.getBoundingClientRect().height
      return {
        kinds: rows.map((row) => [...row.classList].find((name) => name !== "md-diff-row")),
        fills: [add, del, ctx].map((row) => getComputedStyle(row).backgroundColor),
        rowWidth: add.getBoundingClientRect().width,
        innerWidth: pre.clientWidth,
        rowHeights: [...new Set(rows.map((row) => Math.round(pitch(row) * 100) / 100))],
        plainPitch: (plain.getBoundingClientRect().height - parseFloat(getComputedStyle(plain).paddingTop) * 2 - 2) / 12,
        signSelect: getComputedStyle(add.querySelector(".md-diff-sign")!).userSelect,
        signs: [add, del, ctx].map((row) => row.querySelector(".md-diff-sign")!.textContent),
        coloured: pre.querySelectorAll(".md-diff-text [class^=hljs-]").length,
        plainRows: document.querySelectorAll("[data-case=diff] .md-diff-text [class^=hljs-]").length,
      }
    })
    assert.deepEqual(diff.kinds.slice(6, 10), ["md-diff-ctx", "md-diff-del", "md-diff-add", "md-diff-add"])
    assert.notEqual(diff.fills[0], diff.fills[2], "an added row is tinted")
    assert.notEqual(diff.fills[1], diff.fills[2], "a deleted row is tinted")
    assert.notEqual(diff.fills[0], diff.fills[1])
    assert.ok(Math.abs(diff.rowWidth - diff.innerWidth) < 1, `a row spans the block: ${diff.rowWidth}px of ${diff.innerWidth}px`)
    assert.equal(diff.rowHeights.length, 1, `every row is one line tall: ${diff.rowHeights}`)
    assert.ok(Math.abs(diff.rowHeights[0] - diff.plainPitch) < 0.05, `a diff row is ${diff.rowHeights[0]}px, a plain line ${diff.plainPitch}px`)
    assert.equal(diff.signSelect, "none")
    assert.deepEqual(diff.signs, ["+", "-", " "])
    assert.ok(diff.coloured > 10, "`ts-diff` highlights the code on its rows")
    assert.equal(diff.plainRows, 0, "`diff` alone has no language to highlight in")

    // Copy takes the diff as written, signs and all.
    const copied = await copyOf("diff-ts")
    assert.match(copied, /^ export async function retry<T>/)
    assert.ok(copied.includes("\n-      await sleep(100)\n+      // Back off: 100ms, 200ms, 400ms.\n+      await sleep(2 ** attempt * 100)\n"))

    // A git diff of one file: titled from its header, counted, numbered from its hunks.
    const git = await page.evaluate(() => {
      const root = document.querySelector("[data-case=diff-git]")!
      const numbers = [...root.querySelectorAll<HTMLElement>(".md-diff-num")]
      const widths = [...new Set(numbers.map((num) => Math.round(num.getBoundingClientRect().width * 100) / 100))]
      const texts = [...root.querySelectorAll<HTMLElement>(".md-diff-text")].map((text) => Math.round(text.getBoundingClientRect().left * 100) / 100)
      return {
        title: root.querySelector(".md-code-title")?.textContent,
        stat: [...root.querySelectorAll(".md-diff-stat > span")].map((count) => count.textContent),
        drawn: numbers.map((num) => getComputedStyle(num, "::before").content.replace(/"/g, "")),
        widths,
        textLefts: [...new Set(texts)],
        fileRowsShown: [...root.querySelectorAll<HTMLElement>(".md-diff-file")].filter((row) => getComputedStyle(row).display !== "none").length,
        fileRows: root.querySelectorAll(".md-diff-file").length,
        hunks: root.querySelectorAll(".md-diff-hunk").length,
        hunkCut: [...root.querySelectorAll<HTMLElement>(".md-diff-hunk")].map((row) => row.scrollWidth > row.clientWidth),
        scrolls: root.querySelector("pre")!.scrollWidth - root.querySelector("pre")!.clientWidth,
        codeStartsWith: (root.querySelector("code")!.textContent ?? "").slice(0, 10),
      }
    })
    assert.equal(git.title, "packages/server/src/retry.ts")
    assert.deepEqual(git.stat, ["+3", "−2"])
    assert.deepEqual(git.drawn, ["96", "97", "98", "99", "100", "101", "102", "102", "103", "104", "1205", "1205", "1206", "1207"])
    assert.equal(git.widths.length, 1, `one gutter width for every row: ${git.widths}`)
    assert.equal(git.textLefts.length, 1, `the code starts in one column: ${git.textLefts}`)
    assert.equal(git.fileRows, 4)
    assert.equal(git.fileRowsShown, 0, "the title says which file; the header lines are not drawn")
    assert.equal(git.hunks, 2)
    // A hunk header longer than every line of code under it is cut, rather than making the block scroll.
    assert.deepEqual(git.hunkCut, [true, false])
    assert.equal(git.scrolls, 0)
    assert.equal(git.codeStartsWith, "diff --git", "…but they are still in the text Copy takes")

    // Hand-written, context flush left: nothing eaten, and the language named by the fence.
    assert.equal(await page.$eval("[data-case=diff-loose] .md-diff-ctx .md-diff-text", (text) => text.textContent), "def retry(run, attempts=3):\n")
    assert.equal(await page.$eval("[data-case=diff-titled] .md-code-title", (title) => title.textContent), "packages/server/src/retry.ts")
    assert.deepEqual(await page.$$eval("[data-case=diff-tabs] .md-code-tab", (tabs) => tabs.map((tab) => tab.textContent)), ["retry.ts", "sleep.ts"])

    // ── Long blocks ───────────────────────────────────────────────────────────────────────────────
    const readLong = (id: string) => page.evaluate((caseId: string) => {
      const root = document.querySelector(`[data-case=${caseId}]`)!
      // The long block of a case that holds several blocks; otherwise the one (open) panel it holds.
      const shown = [...root.querySelectorAll<HTMLElement>("pre")].filter((each) => getComputedStyle(each).display !== "none")
      const pre = shown.find((each) => each.classList.contains("md-code-long")) ?? shown[0]
      const buttons = [...root.querySelectorAll<HTMLElement>(".md-code-expand")].filter((each) => getComputedStyle(each).display !== "none")
      const style = getComputedStyle(pre)
      return {
        long: pre.classList.contains("md-code-long"),
        clamped: pre.classList.contains("is-clamped"),
        height: pre.getBoundingClientRect().height,
        scrollHeight: pre.scrollHeight,
        linesShown: (pre.clientHeight - parseFloat(style.paddingTop)) / parseFloat(style.lineHeight),
        buttons: buttons.map((button) => button.textContent),
        expanded: buttons.map((button) => button.getAttribute("aria-expanded")),
        framed: !!pre.closest(".md-code-frame"),
        preBorder: style.borderTopWidth,
      }
    }, id)

    const shut = await readLong("long")
    assert.equal(shut.clamped, true)
    assert.ok(Math.abs(shut.linesShown - 24) < 0.05, `a long block shows 24 lines, not ${shut.linesShown}`)
    assert.ok(shut.scrollHeight > shut.height + 500, "the rest of the block is behind the clamp")
    assert.deepEqual(shut.buttons, ["Show all 64 lines"])
    assert.deepEqual(shut.expanded, ["false"])
    assert.equal(shut.framed, true)
    assert.equal(shut.preBorder, "0px", "the frame, not the pre, carries the border")
    // 40 lines is not long, and a document's blocks are never clamped.
    assert.equal((await readLong("at-limit")).long, false)
    const inDocument = await readLong("document")
    assert.equal(inDocument.long, false)
    assert.deepEqual(inDocument.buttons, [])

    // The button opens the block; the label and state follow.
    await page.click("[data-case=long] .md-code-expand")
    const open = await readLong("long")
    assert.equal(open.clamped, false)
    assert.ok(Math.abs(open.height - open.scrollHeight) < 1, "an open block is as tall as its code")
    assert.deepEqual(open.buttons, ["Show less"])
    assert.deepEqual(open.expanded, ["true"])
    // Another block with the same text elsewhere on the page is left as it was until it is redrawn.
    assert.equal((await readLong("card")).clamped, true)

    // A rebuild of the same markdown keeps it open — and opens every other copy of that block.
    await page.click("[data-rerender]")
    await page.waitForFunction(() => document.querySelector("main")!.getAttribute("data-renders") === "1")
    for (const id of ["long", "card", "chip", "narrow"]) {
      const rebuilt = await readLong(id)
      assert.equal(rebuilt.clamped, false, `${id} is still open`)
      assert.deepEqual(rebuilt.buttons, ["Show less"], id)
    }
    assert.equal((await readLong("long-titled")).clamped, true, "a different block was never opened")

    // Shut again, and it stays shut across a rebuild.
    await page.click("[data-case=long] .md-code-expand")
    assert.equal((await readLong("long")).clamped, true)
    assert.deepEqual((await readLong("long")).buttons, ["Show all 64 lines"])
    await page.click("[data-rerender]")
    await page.waitForFunction(() => document.querySelector("main")!.getAttribute("data-renders") === "2")
    assert.equal((await readLong("card")).clamped, true)

    // The whole block is copied, clamped or not.
    assert.equal((await copyOf("long")).split("\n").length, 64)

    // A tab of its own: the button belongs to the open tab, and a short tab has none.
    assert.deepEqual((await readLong("long-tabs")).buttons, ["Show all 52 lines"])
    await page.click("[data-case=long-tabs] .md-code-tab:nth-child(2)")
    assert.deepEqual((await readLong("long-tabs")).buttons, [])
    await page.click("[data-case=long-tabs] .md-code-tab:nth-child(3)")
    assert.deepEqual((await readLong("long-tabs")).buttons, ["Show all 44 lines"])
    // Two buttons in this block, one per long tab; click the one that is drawn.
    const drawn = await page.evaluateHandle(() =>
      [...document.querySelectorAll<HTMLElement>("[data-case=long-tabs] .md-code-expand")].find((each) => getComputedStyle(each).display !== "none")!)
    await drawn.click()
    assert.equal((await readLong("long-tabs")).clamped, false)
    await page.click("[data-case=long-tabs] .md-code-tab:nth-child(1)")
    assert.equal((await readLong("long-tabs")).clamped, true, "opening one tab's block leaves the others shut")

    // A long diff clamps like any other block.
    assert.deepEqual((await readLong("long-diff")).buttons, ["Show all 50 lines"])

    // In the Queue's 300px column every line wraps: nothing scrolls sideways, and the clamp is still a height.
    const narrow = await page.$$eval("[data-case=narrow] pre", (pres) => pres.map((pre) => pre.scrollWidth - pre.clientWidth))
    assert.deepEqual(narrow, [0, 0, 0])
    const narrowDiff = await page.$eval("[data-case=narrow] .md-diff", (pre) => {
      const rows = [...pre.querySelectorAll<HTMLElement>(".md-diff-row")]
      const tall = rows.find((row) => row.getBoundingClientRect().height > 30)!
      const text = tall.querySelector<HTMLElement>(".md-diff-text")!
      const lines = [...text.getClientRects()]
      return { wraps: !!tall, hangs: Math.abs(lines[0].left - text.getBoundingClientRect().left) < 0.5 }
    })
    assert.equal(narrowDiff.wraps, true)
    assert.equal(narrowDiff.hangs, true, "a wrapped row continues under its code, not under its sign")

    // The Edit card draws the same rows from a tool call, and wraps them the same way: a long line
    // continues under its own code, tinted the whole way, and the card's body never scrolls sideways.
    await page.click("[data-case=edit-card] [aria-expanded=false]")
    const editCard = await page.$eval("[data-case=edit-card] .frizz-diff-body", (body) => {
      const del = body.querySelector<HTMLElement>(".frizz-diff-line[data-type=del]")!
      const ctx = body.querySelector<HTMLElement>(".frizz-diff-line[data-type=context]")!
      const code = del.querySelector<HTMLElement>(".frizz-diff-code")!
      const range = document.createRange()
      range.selectNodeContents(code)
      const lines = [...range.getClientRects()]
      return {
        scrolls: body.scrollWidth - body.clientWidth,
        lines: del.getBoundingClientRect().height / ctx.getBoundingClientRect().height,
        hangs: lines.every((line) => line.left - code.getBoundingClientRect().left > -0.5),
        rowWidth: del.getBoundingClientRect().width,
        bodyWidth: body.clientWidth,
      }
    })
    assert.equal(editCard.scrolls, 0, "the Edit card wraps a long line rather than scrolling its body")
    assert.ok(editCard.lines > 1.9, `the long deleted line is drawn on ${editCard.lines} lines`)
    assert.equal(editCard.hangs, true, "a wrapped line continues under its code, not under its number or sign")
    assert.ok(Math.abs(editCard.rowWidth - editCard.bodyWidth) < 1, `the wrapped line's tint spans the card: ${editCard.rowWidth}px of ${editCard.bodyWidth}px`)

    // ── Wrap code, off ────────────────────────────────────────────────────────────────────────────
    // The setting is a browser preference that lib/codeWrap.ts mirrors onto <html>; the fixture's
    // button writes the same preference the Settings row does. Blocks that are already drawn follow
    // it: every line keeps to one line, and its block scrolls sideways instead.
    assert.equal(await page.evaluate(() => document.documentElement.dataset.codeWrap), "on")
    await page.click("[data-wrap-code]")
    await page.waitForFunction(() => document.documentElement.dataset.codeWrap === "off")
    const unwrapped = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>("[data-case=marked-wide] pre")!
      const band = pre.querySelector<HTMLElement>(".is-marked")!
      const short = pre.querySelector<HTMLElement>(".md-line:not(.is-marked)")!
      const scrolls = (el: Element) => el.scrollWidth - el.clientWidth
      return {
        scrolls: scrolls(pre),
        lines: band.getBoundingClientRect().height / short.getBoundingClientRect().height,
        band: band.getBoundingClientRect().width,
        scrollWidth: pre.scrollWidth,
        diff: scrolls(document.querySelector("[data-case=diff-wide] pre")!),
        git: scrolls(document.querySelector("[data-case=diff-git] pre")!),
        editCard: scrolls(document.querySelector("[data-case=edit-card] .frizz-diff-body")!),
        narrow: [...document.querySelectorAll("[data-case=narrow] pre")].map(scrolls),
        narrowSpills: scrolls(document.querySelector("[data-case=narrow]")!),
      }
    })
    assert.ok(unwrapped.scrolls > 100, `with wrapping off the long marked line scrolls its block, by ${unwrapped.scrolls}px`)
    assert.ok(Math.abs(unwrapped.lines - 1) < 0.05, `and is drawn on one line, not ${unwrapped.lines}`)
    // The band is as long as the line, not as wide as the viewport.
    assert.ok(Math.abs(unwrapped.band - unwrapped.scrollWidth) < 1, `band ${unwrapped.band}px of ${unwrapped.scrollWidth}px`)
    assert.ok(unwrapped.diff > 100, "a wide diff fence scrolls sideways")
    assert.ok(unwrapped.editCard > 100, "the Edit card's body scrolls sideways")
    // A hunk header longer than the code under it is still cut, rather than being what makes a block scroll.
    assert.equal(unwrapped.git, 0)
    // One switch for every surface: the Queue's column scrolls its blocks too, each inside itself, and
    // none of them widens the column.
    assert.ok(unwrapped.narrow.every((px) => px > 0), `every block in the 300px column scrolls: ${unwrapped.narrow}`)
    assert.equal(unwrapped.narrowSpills, 0, "a scrolling block stays inside its column")
    // And back on, the same blocks wrap again.
    await page.click("[data-wrap-code]")
    await page.waitForFunction(() => document.documentElement.dataset.codeWrap === "on")
    assert.equal(await page.$eval("[data-case=marked-wide] pre", (pre) => pre.scrollWidth - pre.clientWidth), 0)

    // Inside an answer chip the button is above the chip's stretched hit area, so the click reaches it.
    const hit = await page.$eval("[data-case=chip] .md-code-expand", (button) => {
      // elementFromPoint answers only inside the viewport, and the chip is below the fold.
      button.scrollIntoView({ block: "center" })
      const box = button.getBoundingClientRect()
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button
    })
    assert.equal(hit, true)

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
