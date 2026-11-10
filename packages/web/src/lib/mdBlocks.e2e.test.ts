import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_MD_BLOCKS_E2E_URL to its origin, e.g.
//   FRIZZ_MD_BLOCKS_E2E_URL=http://localhost:5831 nub run test packages/web/src/lib/mdBlocks.e2e.test.ts
const baseUrl = process.env.FRIZZ_MD_BLOCKS_E2E_URL

type Page = import("puppeteer").Page
type FixtureWindow = Window & { __pwned?: string; __chipHits?: number; __picked?: number[]; __toggles?: string[] }

// lib/callouts.test.ts pins the callout's detection and markup. What only a browser can say is whether
// that markup — and the raw `<details>`, `<kbd>`, `<sub>`, `<sup>` and `<mark>` an author writes —
// survives the sanitizer with nothing an author could abuse, whether the stylesheet draws each without
// growing its line, and whether the browser's own toggle is remembered across a rebuild.
test("callouts, sections and inline keys render, stay sanitized, and a section stays as the reader left it", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    // The fixture declares no favicon, so vite 404s /favicon.ico on every bare fixture page here.
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon\.ico|404 \(Not Found\)/.test(m.text())) pageErrors.push(m.text())
    })
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/md-blocks-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-case=narrow] summary")

    // NOTE: no named function expressions in evaluate. Nub's transpiler adds a `__name` keep-names shim
    // that does not exist inside the page.

    // ── The sanitizer kept what the renderers minted and nothing an author could abuse ──
    const clean = await page.evaluate(() => {
      const handlers: string[] = []
      const styled: string[] = []
      for (const el of document.querySelectorAll("[data-case] *")) {
        // The fixture's own hand-built chip and the real question card carry React's attributes, not
        // the sanitizer's output; only sanitized prose is in question.
        if (!el.closest(".md-body, .md-inline")) continue
        for (const attr of el.attributes) {
          if (/^on/i.test(attr.name)) handlers.push(`${el.tagName}@${attr.name}`)
          if (attr.name === "style" && !el.closest("pre")) styled.push(el.tagName)
        }
      }
      const attrs = (el: Element | null) => (el ? [...el.attributes].map((a) => `${a.name}=${a.value}`).sort() : null)
      const abused = document.querySelector("[data-case=details-abuse] details")!
      const inline = document.querySelector("[data-case=inline-abuse]")!
      return {
        pwned: (window as FixtureWindow).__pwned ?? null,
        handlers,
        styled,
        warning: document.querySelector("[data-case=callout-warning] blockquote")?.className ?? null,
        warningTitle: document.querySelector("[data-case=callout-warning] blockquote > p.md-callout-title")?.textContent ?? null,
        abused: attrs(abused),
        abusedSummary: attrs(abused.querySelector(":scope > summary")),
        abusedLabels: [...abused.querySelectorAll(".md-summary-label")].map((label) => ({
          ours: label.parentElement?.tagName === "SUMMARY",
          text: label.textContent,
          className: label.className,
        })),
        abusedInnerSpan: attrs(abused.querySelector(".md-summary-label > span")),
        abusedBody: abused.querySelector(":scope > p")?.textContent ?? null,
        forged: attrs(document.querySelector("[data-case=details-forged] details")),
        inlineTags: [...inline.querySelectorAll("kbd, sup, sub, mark")].map((el) => `${el.tagName.toLowerCase()}[${attrs(el)!.join(",")}]`),
      }
    })
    assert.equal(clean.pwned, null, "no probe payload may run")
    assert.deepEqual(clean.handlers, [], "no event-handler attribute may survive sanitizing")
    assert.deepEqual(clean.styled, [], "no author style may survive outside an ansi fence")
    assert.equal(clean.warning, "md-callout md-callout-warning")
    assert.equal(clean.warningTitle, "Warning")
    // `open="yes"` is open, rewritten bare; the rendered-open mark is the sanitizer's own; the rest is gone.
    assert.deepEqual(clean.abused, ["data-rendered-open=", "open="])
    assert.deepEqual(clean.abusedSummary, [])
    // One label wrapper, ours. The author's look-alike span lost its class on the way in.
    assert.deepEqual(clean.abusedLabels, [{ ours: true, text: "Abused", className: "md-summary-label" }])
    assert.deepEqual(clean.abusedInnerSpan, [])
    assert.equal(clean.abusedBody, "Body survives.")
    assert.deepEqual(clean.forged, [], "a hand-written rendered-open mark does not survive on a closed section")
    // An author writes no class on any tag (lib/markdown.ts CLASS_BY_TAG), so the `<sup>` arrives bare.
    assert.deepEqual(clean.inlineTags, ["kbd[]", "sup[]", "mark[]", "sub[]"])

    // ── Callouts: one treatment per type, the body in the prose colour ──
    const callouts = await page.evaluate(() => {
      const kinds = ["note", "tip", "important", "warning", "caution"]
      const read = (kind: string) => {
        const quote = document.querySelector<HTMLElement>(`[data-case=callout-${kind}] blockquote`)!
        const title = quote.querySelector<HTMLElement>(".md-callout-title")!
        const icon = getComputedStyle(title, "::before")
        const head = getComputedStyle(title)
        const box = quote.getBoundingClientRect()
        const strip = title.getBoundingClientRect()
        return {
          frame: getComputedStyle(quote).borderLeftColor,
          rule: head.borderBottomColor,
          wash: head.backgroundColor,
          title: head.color,
          icon: icon.backgroundColor,
          glyph: icon.maskImage || icon.webkitMaskImage,
          body: getComputedStyle(quote.querySelector("p:not(.md-callout-title)")!).color,
          // The title's own line: the strip less its vertical padding and its hairline.
          titleLine: strip.height - parseFloat(head.paddingTop) - parseFloat(head.paddingBottom) - parseFloat(head.borderBottomWidth),
          gap: quote.querySelector("p:not(.md-callout-title)")!.getBoundingClientRect().top - strip.bottom,
          fontSize: parseFloat(getComputedStyle(quote).fontSize),
          // How far the strip stands in from the box's outer edges: the 1px border, both sides and top.
          inset: [strip.left - box.left, box.right - strip.right, strip.top - box.top],
        }
      }
      const empty = document.querySelector<HTMLElement>("[data-case=callout-empty] blockquote")!
      const plain = document.querySelector<HTMLElement>("[data-case=callout-unknown] blockquote")!
      const alias = document.querySelector<HTMLElement>("[data-case=callout-alias] blockquote")!
      const prose = document.querySelector<HTMLElement>("[data-case=inline] p")!
      return {
        types: kinds.map(read),
        plainClass: plain.className,
        plainText: plain.textContent ?? "",
        plainColor: getComputedStyle(plain.querySelector("p")!).color,
        aliasClass: alias.className,
        aliasTitle: alias.querySelector(".md-callout-title")?.textContent ?? null,
        proseColor: getComputedStyle(prose).color,
        proseLine: parseFloat(getComputedStyle(prose).lineHeight),
        listed: document.querySelector("[data-case=callout-list] li > blockquote.md-callout-tip > .md-callout-title")?.textContent ?? null,
        empty: empty.children.length,
        // A callout with no body is its header alone: the box ends at the strip's foot.
        emptyFoot: empty.getBoundingClientRect().bottom - empty.querySelector(".md-callout-title")!.getBoundingClientRect().bottom,
        // A code fence, a task list and prose inside one callout.
        blocks: [...document.querySelector("[data-case=callout-blocks] blockquote")!.children].map((child) => child.tagName.toLowerCase()),
        document: {
          title: document.querySelector("[data-case=document] .md-callout-tip > .md-callout-title")?.textContent ?? null,
          body: document.querySelector("[data-case=document] .md-callout-tip > p:not(.md-callout-title)")?.innerHTML ?? null,
        },
      }
    })
    const distinct = (values: string[]) => new Set(values).size
    // Every part of the box is coded to its type: the frame, the header's wash, the title's ink and the
    // glyph (styles.css § Callouts). A neutral grey frame around a coloured header read as a foreign box.
    assert.equal(distinct(callouts.types.map((type) => type.frame)), 5, `each type draws its own frame: ${callouts.types.map((type) => type.frame).join(" ")}`)
    assert.equal(distinct(callouts.types.map((type) => type.wash)), 5, `each type washes its own header: ${callouts.types.map((type) => type.wash).join(" ")}`)
    assert.equal(distinct(callouts.types.map((type) => type.title)), 5)
    assert.equal(distinct(callouts.types.map((type) => type.glyph)), 5, "each type carries its own glyph")
    for (const type of callouts.types) {
      assert.match(type.glyph, /^url\("data:image\/svg\+xml/)
      assert.notEqual(type.wash, "rgba(0, 0, 0, 0)", "the header is washed")
      assert.equal(type.rule, type.frame, "the line under the header is the frame's own hairline")
      assert.equal(type.icon, type.title, "the icon is painted in the title's colour")
      assert.equal(type.body, callouts.proseColor, "a callout's body is prose, not a muted quote")
      // The icon is a 1em box on a 1.7 line: it must not have made the title's line any taller.
      assert.ok(Math.abs(type.titleLine - callouts.proseLine) < 0.05, `the title is one prose line tall (${type.titleLine} vs ${callouts.proseLine})`)
      assert.ok(Math.abs(type.gap - 0.75 * type.fontSize) < 0.5, `the body sits the box's inset under the header (${type.gap}px)`)
      assert.ok(type.inset.every((edge) => Math.abs(edge - 1) < 0.01), `the header runs the box's whole inner width, from its top (${type.inset})`)
    }
    assert.ok(Math.abs(callouts.emptyFoot - 1) < 0.01, `a callout with no body ends at its header (${callouts.emptyFoot}px under it)`)
    // A plain quote's one class is its copy button's (lib/quoteCopy.ts).
    assert.equal(callouts.plainClass, "md-quote", "an unknown type is left a plain blockquote")
    assert.match(callouts.plainText, /\[!sic\]/)
    assert.notEqual(callouts.plainColor, callouts.proseColor, "a plain quote keeps its muted tone")
    assert.equal(callouts.aliasClass, "md-callout md-callout-caution")
    assert.equal(callouts.aliasTitle, "Caution")
    assert.equal(callouts.listed, "Tip")
    assert.equal(callouts.empty, 1, "a callout with no body is its title alone")
    assert.deepEqual(callouts.blocks, ["p", "p", "ul", "span", "p"])
    assert.equal(callouts.document.title, "In a document")
    assert.equal(callouts.document.body, "A hard-wrapped body\nstays one paragraph.")

    // ── Sections ──
    const section = (id: string) => page.evaluate((caseId: string) => {
      const details = document.querySelector<HTMLDetailsElement>(`[data-case=${caseId}] details`)!
      const summary = details.querySelector<HTMLElement>(":scope > summary")!
      const chevron = getComputedStyle(summary, "::before")
      const label = summary.querySelector<HTMLElement>(":scope > .md-summary-label")
      const first = [...details.children].find((child) => child !== summary) as HTMLElement | undefined
      return {
        open: details.open,
        attr: details.getAttribute("open"),
        display: getComputedStyle(summary).display,
        marker: getComputedStyle(summary).listStyleType,
        cursor: getComputedStyle(summary).cursor,
        rotate: chevron.rotate,
        chevronWidth: parseFloat(chevron.width),
        fontSize: parseFloat(getComputedStyle(summary).fontSize),
        summaryHeight: summary.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(summary).lineHeight),
        labelText: label?.textContent ?? null,
        // A closed section's body takes no room: the section is exactly its summary.
        height: details.getBoundingClientRect().height,
        // `checkVisibility`, not a rect: Chrome keeps a closed section's body in a `content-visibility:
        // hidden` slot, where a box can still report the size it last had.
        bodyVisible: !!first && first.checkVisibility(),
        labelLeft: label?.getBoundingClientRect().left ?? -1,
        bodyLeft: first?.getBoundingClientRect().left ?? -1,
        left: details.getBoundingClientRect().left,
        summaryRight: summary.getBoundingClientRect().right,
        right: details.getBoundingClientRect().right,
      }
    }, id)
    const toggles = () => page.evaluate(() => (window as FixtureWindow).__toggles ?? [])
    const mouseClick = async (selector: string) => {
      const at = await page.$eval(selector, (node) => {
        // A click lands only inside the viewport, and most of the fixture is below the fold.
        node.scrollIntoView({ block: "center" })
        const box = node.getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      })
      await page.mouse.click(at.x, at.y)
    }
    const waitOpen = (id: string, open: boolean) => page.waitForFunction(
      (caseId: string, want: boolean) => document.querySelector<HTMLDetailsElement>(`[data-case=${caseId}] details`)!.open === want,
      {}, id, open,
    )
    const rerender = async () => {
      const before = await page.$eval("main", (main) => Number(main.getAttribute("data-renders")))
      await page.click("[data-rerender]")
      await page.waitForFunction((n: number) => document.querySelector("main")!.getAttribute("data-renders") === String(n), {}, before + 1)
    }

    const closed = await section("details")
    assert.equal(closed.open, false)
    assert.equal(closed.bodyVisible, false, "a closed section shows its summary alone")
    assert.equal(closed.display, "flex")
    assert.equal(closed.marker, "none", "the native disclosure triangle is gone")
    assert.equal(closed.cursor, "pointer")
    assert.equal(closed.rotate, "none")
    assert.equal(closed.labelText, "Full test output")
    assert.ok(Math.abs(closed.chevronWidth - closed.fontSize) < 0.01, "the chevron is 1em of the summary's own type")
    assert.ok(Math.abs(closed.summaryHeight - closed.lineHeight) < 0.05, `the chevron does not grow the row (${closed.summaryHeight} vs ${closed.lineHeight})`)
    assert.ok(Math.abs(closed.height - closed.summaryHeight) < 0.05)
    assert.ok(closed.summaryRight < closed.right - 100, "the row is as wide as its label, not the column")

    // The browser's echo of an inserted `<details open>` is on the page, which is what makes the twin
    // below a real test: that event must not have been recorded as anybody's choice.
    assert.ok((await toggles()).includes("details-open:open"), "the page saw the inserted section's own toggle")
    assert.equal((await section("details-open")).open, true, "an authored `open` is the default")
    assert.equal((await section("details-twin")).open, false)

    // A click opens it: chevron turned, body shown on the label's own left edge.
    await mouseClick("[data-case=details] summary .md-summary-label")
    await waitOpen("details", true)
    // The quarter-turn is a 120ms transition; read it once it has landed.
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-case=details] summary")!, "::before").rotate === "90deg")
    const opened = await section("details")
    assert.equal(opened.bodyVisible, true)
    assert.ok(Math.abs(opened.labelLeft - opened.bodyLeft) < 0.05, `label and body share a left edge (${opened.labelLeft} vs ${opened.bodyLeft})`)
    assert.ok(opened.labelLeft - opened.left > 8, "the chevron has its own gutter")
    // Markdown inside it is Markdown: a paragraph with inline code, a fence, a list, a tab group.
    const inside = await page.evaluate(() => {
      const details = document.querySelector("[data-case=details] details")!
      const tabs = details.querySelector(".md-code-tabs")!
      return {
        children: [...details.children].map((child) => `${child.tagName.toLowerCase()}${child.className ? `.${child.className.split(" ")[0]}` : ""}`),
        code: details.querySelector("p code")?.textContent ?? null,
        items: details.querySelectorAll("ul > li").length,
        tabs: [...tabs.querySelectorAll(".md-code-tab")].map((tab) => tab.textContent),
        shown: [...tabs.querySelectorAll<HTMLElement>(":scope > pre")].filter((pre) => getComputedStyle(pre).display !== "none").map((pre) => pre.textContent),
      }
    })
    assert.deepEqual(inside.children, ["summary", "p", "span.md-code", "ul", "span.md-code"])
    assert.equal(inside.code, "packages/web")
    assert.equal(inside.items, 3)
    assert.deepEqual(inside.tabs, ["npm", "pnpm"])
    assert.deepEqual(inside.shown, ["npm test\n"])
    await mouseClick("[data-case=details] .md-code-tab:nth-child(2)")
    assert.deepEqual(await page.$$eval("[data-case=details] .md-code-tabs > pre.is-active", (panels) => panels.map((panel) => panel.textContent)), ["pnpm test\n"])
    assert.equal((await section("details")).open, true, "a click inside the body does not close the section")

    // A rebuild of the same markdown — a streaming delta, a virtualized remount — leaves it open, and
    // opens every other section with that summary. The authored-open one is still open, and its twin,
    // which nobody touched, is still closed.
    await rerender()
    for (const id of ["details", "card", "document", "narrow"]) assert.equal((await section(id)).open, true, `${id} reopens`)
    assert.equal((await section("details-open")).open, true)
    assert.equal((await section("details-twin")).open, false, "an authored `open` is not a reader's choice")
    assert.equal((await section("details-tight")).open, false)

    // Closing is remembered the same way, over the author's default.
    await mouseClick("[data-case=details-open] summary .md-summary-label")
    await waitOpen("details-open", false)
    await rerender()
    assert.equal((await section("details-open")).open, false, "the reader closed it; the author's `open` no longer decides")
    assert.equal((await section("details-open")).attr, null)
    assert.equal((await section("details")).open, true)

    // The keyboard: a summary is focusable, and Enter toggles it through the same event.
    await page.focus("[data-case=details-tight] summary")
    await page.keyboard.press("Enter")
    await waitOpen("details-tight", true)
    await rerender()
    const tight = await section("details-tight")
    assert.equal(tight.open, true)
    // Written with no blank lines, the body is one HTML block: plain text, the asterisks included.
    assert.match(await page.$eval("[data-case=details-tight] details", (details) => details.textContent ?? ""), /The body is \*\*not\*\* parsed as Markdown here,\s+so it reads as plain text\./)

    // A summary carrying inline markup is still one label, spaces intact.
    assert.equal((await section("details-inline")).labelText, "Output of nub run typecheck, trimmed")
    assert.equal(await page.$eval("[data-case=details-inline] .md-summary-label", (label) => label.children.length), 2)

    // ── Inside an answer chip ──
    // The summary is above the chip's stretched button, so the click reaches it and not the button.
    const hit = await page.$eval("[data-case=chip] summary", (summary) => {
      summary.scrollIntoView({ block: "center" })
      const box = summary.getBoundingClientRect()
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return { onSummary: !!at && summary.contains(at), tag: at?.tagName ?? null }
    })
    assert.equal(hit.onSummary, true, `the summary wins the hit test (got ${hit.tag})`)
    const chipHits = () => page.evaluate(() => (window as FixtureWindow).__chipHits ?? -1)
    await mouseClick("[data-case=chip] summary")
    await waitOpen("chip", true)
    assert.equal(await chipHits(), 0, "the stretched button did not receive the summary's click")
    // The control: the same button does take a click on the chip's own padding.
    const edge = await page.$eval("[data-chip-hit]", (button) => {
      const box = button.getBoundingClientRect()
      return { x: box.left + 4, y: box.top + box.height / 2 }
    })
    await page.mouse.click(edge.x, edge.y)
    assert.equal(await chipHits(), 1)

    // The real card: its own click filter stands down for a summary, and still picks on the label.
    const picked = () => page.evaluate(() => (window as FixtureWindow).__picked ?? [])
    // (Still closed: the chip above chose this summary open, but nothing has re-rendered this card.)
    assert.equal((await section("question")).open, false)
    await mouseClick("[data-case=question] [data-question-option] summary")
    await waitOpen("question", true)
    assert.deepEqual(await picked(), [], "toggling a section inside an option does not pick the option")
    await mouseClick("[data-case=question] [data-question-option] summary")
    await waitOpen("question", false)
    assert.deepEqual(await picked(), [])
    await mouseClick("[data-case=question] [data-question-option] .md-inline")
    assert.deepEqual(await picked(), [0], "the rest of the row still picks it")

    // ── Keys, scripts and highlights survive on both paths and leave their line alone ──
    const inline = await page.evaluate(() => {
      const tags = (root: Element) => [...root.querySelectorAll("kbd, sub, sup, mark")].map((el) => `${el.tagName.toLowerCase()}:${el.textContent}`)
      const kbd = document.querySelector<HTMLElement>("[data-case=inline] kbd")!
      const option = document.querySelector<HTMLElement>("[data-case=question] [data-question-option] .md-inline kbd")
      const mark = document.querySelector<HTMLElement>("[data-case=inline] mark")!
      // The height of each line box but the last: the distance from one line's first glyph to the next's.
      const lineHeights = (id: string) => {
        const root = document.querySelector(`[data-case=${id}]`)!
        const host = root.querySelector("p") ?? root
        const tops: number[] = []
        for (const node of host.childNodes) {
          if (node.nodeType !== 3 || !/^\s*A /.test(node.textContent ?? "")) continue
          const range = document.createRange()
          const start = node.textContent!.indexOf("A")
          range.setStart(node, start)
          range.setEnd(node, start + 1)
          tops.push(range.getBoundingClientRect().top)
        }
        return tops.slice(1).map((top, i) => +(top - tops[i]).toFixed(3))
      }
      return {
        block: tags(document.querySelector("[data-case=inline]")!),
        label: tags(document.querySelector("[data-case=chip-label]")!),
        kbd: {
          family: getComputedStyle(kbd).fontFamily,
          prose: getComputedStyle(kbd.parentElement!).fontFamily,
          size: parseFloat(getComputedStyle(kbd).fontSize) / parseFloat(getComputedStyle(kbd.parentElement!).fontSize),
          display: getComputedStyle(kbd).display,
          border: getComputedStyle(kbd).borderBottomWidth,
        },
        optionKbd: option ? getComputedStyle(option).display : null,
        markBg: getComputedStyle(mark).backgroundColor,
        markColor: getComputedStyle(mark).color,
        proseColor: getComputedStyle(mark.parentElement!).color,
        lines: { transcript: lineHeights("inline-lines"), card: lineHeights("card-lines"), chip: lineHeights("chip-lines") },
      }
    })
    assert.deepEqual(inline.block, ["kbd:Ctrl", "kbd:C", "sup:2", "sub:2", "mark:this part"])
    assert.deepEqual(inline.label, ["kbd:1", "sup:10", "mark:now"], "the inline path shares the sanitizer")
    assert.equal(inline.kbd.family, inline.kbd.prose, "a keycap is set in the prose face, not the UA's monospace")
    assert.ok(Math.abs(inline.kbd.size - 0.875) < 0.001)
    assert.equal(inline.kbd.display, "inline")
    assert.equal(inline.kbd.border, "2px")
    assert.equal(inline.optionKbd, "inline")
    assert.notEqual(inline.markBg, "rgb(255, 255, 0)", "not the UA's opaque yellow")
    assert.equal(inline.markColor, inline.proseColor, "a highlight keeps the prose colour")
    // Plain, key, scripts, highlight, plain: four distances between five lines. As the UA draws them
    // these fail — a monospace `<kbd>` set the transcript's lines 24.80px apart against 23.80px, and a
    // `<sup>` with its own line-height 25.47px (measured 2026-10-11).
    for (const [scale, heights] of Object.entries(inline.lines)) {
      assert.equal(heights.length, 4, `${scale}: five lines were found`)
      // A line that grows moves its own glyphs down as well as the next line's, so a taller box shows
      // in the distance on either side of it. Every distance equal means no line grew.
      for (const height of heights) {
        assert.ok(Math.abs(height - heights[0]) < 0.01, `${scale}: lines are ${heights.join(", ")}px apart, not all a plain line's ${heights[0]}px`)
      }
    }

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
