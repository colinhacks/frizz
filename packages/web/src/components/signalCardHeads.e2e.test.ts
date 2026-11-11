import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5233 --strictPort --host 127.0.0.1 &
//   FRIZZ_SIGNAL_CARD_HEADS_E2E_URL=http://127.0.0.1:5233 nub --test src/components/signalCardHeads.e2e.test.ts
const baseUrl = process.env.FRIZZ_SIGNAL_CARD_HEADS_E2E_URL

// ONE HEAD FOR EVERY BLOCK TYPE (2026-10-13): a small glyph and the kind's word over the title, then a
// rule (maintainer: "all block types should have a header"; "a small icon followed by a small word over
// the title will look good"). Drawn against the real cards in fence-card-gallery-fixture.html — every done
// and awaiting shape, and the question cards — and the registered question with its ×:
//
//   1. every card heads with its kind line, then its title when it has one, then the rule, then the body;
//   2. the rule sits the same ink distance under the head on every card (18px under a bare kind's
//      baseline, 20px under a title's) and the body's first cap the same distance under the rule;
//   3. every kind glyph's ink centres on its word's cap band, at one ink gap from the word, though each
//      glyph carries different dead space in its box — and the question's × centres on the same band;
//   4. a bare done card draws no rule, and its Mark-as-done band's border sits where the rule would;
//   5. the QUESTION card's kinds paint one ink height: "Select multiple" drew a 7px list glyph beside the
//      10px circle of "Question" until 2026-10-13 (KindLabel's `evenInk`);
//   6. an answered question keeps the kind its live card wore: a settled `multi` read "Question" until
//      2026-10-13, so the card changed its name as it greyed in place.
const MEASURE = () => {
  const ctx = document.createElement("canvas").getContext("2d")!
  const metrics = (node: Text) => {
    const span = document.createElement("span")
    span.style.whiteSpace = "nowrap"
    node.parentNode!.insertBefore(span, node)
    span.appendChild(node)
    const probe = document.createElement("span")
    probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
    span.insertBefore(probe, node)
    const baseline = probe.getBoundingClientRect().bottom
    // Read into a string NOW: a CSSStyleDeclaration is live, and once the span is removed below it reads
    // empty — the canvas then falls back to its 10px default and every cap height comes out short.
    const cs = getComputedStyle(span)
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const range = document.createRange()
    range.selectNodeContents(node)
    const box = range.getBoundingClientRect()
    probe.remove()
    span.parentNode!.insertBefore(node, span)
    span.remove()
    ctx.font = font
    const m = ctx.measureText(node.textContent ?? "")
    return { baseline, capTop: baseline - ctx.measureText("H").actualBoundingBoxAscent, inkLeft: box.left - m.actualBoundingBoxLeft }
  }
  const firstText = (el: Element) =>
    document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/\S/.test(n.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) }).nextNode() as Text | null
  // An SVG geometry child's client rect is its ink (stroke excluded), unioned over every child.
  const ink = (svg: Element) => {
    const rs = [...svg.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon")].map((g) => g.getBoundingClientRect())
    return { top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)), right: Math.max(...rs.map((r) => r.right)) }
  }
  return [...document.querySelectorAll("[data-card-kind]")].map((kind) => {
    const card = kind.closest(".rounded-xl")!
    const word = metrics(firstText(kind)!)
    const glyph = ink(kind.querySelector("svg")!)
    const capMid = (word.capTop + word.baseline) / 2
    const titleEl = card.querySelector("[data-card-title]")
    const title = titleEl ? metrics(firstText(titleEl)!) : null
    const headBaseline = title && titleEl ? title.baseline + titleEl.getBoundingClientRect().height - parseFloat(getComputedStyle(titleEl).lineHeight) : word.baseline
    const rule = card.querySelector("[data-card-rule]")
    const band = card.querySelector("[data-card-actions]")
    const bodyText = card.querySelector(".card-md") ? firstText(card.querySelector(".card-md")!) : null
    const x = card.querySelector("[data-dismiss-question] svg")
    const order = [kind, titleEl, rule, card.querySelector(".card-md")].filter(Boolean).map((el) => el!.getBoundingClientRect().top)
    return {
      section: card.closest("[data-fence-section]")?.getAttribute("data-fence-section") ?? null,
      kind: kind.textContent,
      titled: !!titleEl,
      ordered: order.every((t, i) => i === 0 || t > order[i - 1]),
      headToRule: rule ? rule.getBoundingClientRect().top - headBaseline : null,
      ruleToBody: rule && bodyText && !card.querySelector("[data-card-actions]")?.contains(bodyText) ? metrics(bodyText).capTop - rule.getBoundingClientRect().top : null,
      headToBand: !rule && band ? band.getBoundingClientRect().top - headBaseline : null,
      glyphVsCap: capMid - (glyph.top + glyph.bottom) / 2,
      glyphInk: glyph.bottom - glyph.top,
      question: !!kind.closest(".bg-question"),
      settled: !!kind.closest("[data-settled-question]"),
      glyphToWord: word.inkLeft - glyph.right,
      xVsCap: x ? capMid - (ink(x).top + ink(x).bottom) / 2 : null,
    }
  })
}

test("every block type heads with its kind over its title, at one rhythm", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push(m.text()) })
    await page.setViewport({ width: 720, height: 1200, deviceScaleFactor: 2 })
    const read = async (path: string) => {
      await page.goto(`${baseUrl}/${path}`, { waitUntil: "networkidle0" })
      await page.evaluate(() => { document.documentElement.dataset.font = "sans" })
      await page.waitForSelector("[data-card-kind]")
      // Every reading is an ink distance, so it waits for the page to settle first: the fixture answers
      // the code chips' local-path lookups after first paint, and the fonts it measures must have landed.
      await page.waitForNetworkIdle({ idleTime: 400 })
      await page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
      return page.evaluate(MEASURE)
    }
    const gallery = await read("fence-card-gallery-fixture.html")
    const registered = await read("registered-question-fixture.html")
    const cards = [...gallery, ...registered]
    const by = (section: string) => gallery.find((c) => c.section === section)!
    const near = (v: number | null, want: number, tol: number, what: string) =>
      assert.ok(v !== null && Math.abs(v - want) <= tol, `${what}: ${v} (want ${want} ± ${tol})`)

    // 1. The kinds, and the order.
    assert.equal(by("g-done").kind, "Done")
    assert.ok(!by("g-done").titled && by("g-done-titled").titled, "a done card's title is the worker's `title:`, never its body")
    assert.equal(by("g-shell-midturn").kind, "Background shells running")
    assert.ok(gallery.filter((c) => c.kind === "Awaiting").length >= 5, "the generic awaiting shapes name themselves Awaiting")
    assert.ok(cards.some((c) => c.kind === "Question") && cards.some((c) => c.kind === "Select multiple"), "the question cards wear the kind line too")
    for (const c of cards) assert.ok(c.ordered, `${c.section ?? c.kind}: kind, then title, then rule, then body`)

    // 2. One rhythm around the rule.
    for (const c of cards.filter((c) => c.headToRule !== null)) {
      near(c.headToRule, c.titled ? 20 : 18, 0.5, `${c.section ?? c.kind}: head's last baseline to the rule`)
      if (c.ruleToBody !== null) near(c.ruleToBody, 18.84, 0.5, `${c.section ?? c.kind}: the rule to the body's first cap`)
    }

    // 3. Every glyph on its word's cap band, at one ink gap, and the × on the same band.
    for (const c of cards) {
      near(c.glyphVsCap, 0, 0.35, `${c.kind}: glyph ink centre against the word's cap band`)
      assert.ok(c.glyphToWord >= 5.4 && c.glyphToWord <= 6.8, `${c.kind}: glyph ink to word ${c.glyphToWord}`)
    }
    const xs = registered.filter((c) => c.xVsCap !== null)
    assert.ok(xs.length > 0, "the registered question draws its ×")
    for (const c of xs) near(c.xVsCap, 0, 0.5, "the × against the kind word's cap band")

    // 4. A bare done: no rule, and the band's border where the rule would be.
    const empty = by("g-done-empty")
    assert.equal(empty.headToRule, null, "no rule over a card with no body")
    near(empty.headToBand, 18, 0.5, "the band's border sits at the rule's distance")

    // 5. One ink height across the question card's kinds (stroke excluded, as `ink` reads it).
    const asked = cards.filter((c) => c.question)
    assert.ok(asked.some((c) => c.kind === "Question") && asked.some((c) => c.kind === "Select multiple"), "both kinds are on the page")
    const inks = asked.map((c) => c.glyphInk)
    assert.ok(Math.max(...inks) - Math.min(...inks) < 1, `question kind glyphs' ink heights: ${asked.map((c) => `${c.kind} ${c.glyphInk.toFixed(2)}`).join(", ")}`)

    // 6. Settled cards are headed as their live cards were; only a follow-up is named by its position.
    const answered = (await read("registered-question-fixture.html?fence=settled")).filter((c) => c.settled)
    assert.deepEqual(answered.map((c) => c.kind), ["Question", "Follow-up", "Select multiple"])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
