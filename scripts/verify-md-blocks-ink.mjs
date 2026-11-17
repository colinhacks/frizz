// WHERE THE INK SITS in the two glyph-beside-label rows lib/markdown.ts renders: a callout's title (icon
// + word) and a `<details>` summary (chevron + label). Both glyphs are CSS masks on a `::before`, so
// there is no element to take a rect from and no SVG child whose box is its ink: `getBoundingClientRect`
// on the row returns the same numbers whether the glyph is on the cap band or 2px off it. This has to
// be a PIXEL measurement, and it is the one the comments in styles.css (§ Callouts, disclosures, keys
// and scripts) quote. Re-run it rather than re-guessing when the type scale or a glyph changes.
//
// Method: screenshot each row at a high deviceScaleFactor, decode it in the page, and split the painted
// columns into marks — the glyph is the first unbroken run of inked columns, the label's first letter
// is the next. Every row measured here opens its label with a flat-topped capital, so that letter's
// rows ARE the rendered cap band, the string-independent reference a glyph is centred against. Edges
// are taken at half of each mark's own peak contrast, so a muted chevron and a full-strength letter are
// both read at the middle of their antialiasing ramp.
//
//   vertical   capCentre − glyphCentre. NEGATIVE = the glyph sits BELOW the cap band.
//   inkGap     glyph's right ink edge → the letter's left ink edge. What the eye reads as the gap.
//   ink        the glyph's painted width × height, beside what its viewBox geometry predicts — the
//              instrument check: if these disagree, distrust every other number in the row.
//
// Each row is measured at its shipped size and again at 2×, where a correction written in `em`/`cap`
// must leave the same residual.
//
// Usage:
//   cd packages/web && nubx vite --port 5831 --strictPort
//   nub scripts/verify-md-blocks-ink.mjs --url=http://localhost:5831 [--theme=light] [--dsf=8]
//     [--only=<substring of a row name>] [--css=<extra rules, to try a change before writing it>]
import { launchHeadless } from "./lib/headless-browser.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const base = opt("url", "http://localhost:5831")
const theme = opt("theme", "dark")
const DSF = Number(opt("dsf", "8"))
const only = opt("only", "")
const extraCss = opt("css", "")
// A glyph more than this far off the cap band's centre at its shipped size is visibly off it.
const TOL_PX = 0.3

// [name, row selector, the glyph's ink in em as its viewBox geometry gives it: width, height]
const CIRCLE = [22 / 24, 22 / 24]
const ROWS = [
  ["callout note", "[data-case=callout-note] .md-callout-title", CIRCLE],
  ["callout tip", "[data-case=callout-tip] .md-callout-title", [14 / 24, 22 / 24]],
  ["callout important", "[data-case=callout-important] .md-callout-title", [20 / 24, 20 / 24]],
  ["callout warning", "[data-case=callout-warning] .md-callout-title", [22 / 24, 20 / 24]],
  ["callout caution", "[data-case=callout-caution] .md-callout-title", CIRCLE],
  ["callout warning · card", "[data-case=card] .md-callout-warning > .md-callout-title", [22 / 24, 20 / 24]],
  ["callout warning · chip", "[data-case=chip] .md-callout-title", [22 / 24, 20 / 24]],
  ["summary closed", "[data-case=details] summary", [8 / 24, 14 / 24]],
  ["summary open", "[data-case=details-open] summary", [14 / 24, 8 / 24]],
  ["summary closed · card", "[data-case=card] summary", [8 / 24, 14 / 24]],
  ["summary closed · chip", "[data-case=chip] summary", [8 / 24, 14 / 24]],
].filter(([name]) => name.includes(only))

const browser = await launchHeadless({ protocolTimeout: 120_000 })
const failures = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: DSF })
  await page.goto(`${base}/md-blocks-fixture.html${theme === "light" ? "?theme=light" : ""}`, { waitUntil: "networkidle2" })
  await page.waitForSelector("[data-case=narrow] summary")
  if (extraCss) await page.addStyleTag({ content: extraCss })

  for (const scale of [1, 2]) {
    // Scale the type, not the page: every dimension under test is in `em` or `cap`, so doubling the
    // font size doubles the real geometry. The handle is kept so exactly this tag can be removed.
    const tag = scale === 1 ? null : await page.addStyleTag({
      content: `[data-case], [data-case] .md-body, .md-body[data-case] { font-size: ${scale * 100}% !important }
        .md-body[data-case], [data-case].md-body { font-size: ${14 * scale}px !important }
        .card-md .md-body[data-case] { font-size: ${13 * scale}px !important }
        [data-question-option] .md-body[data-case] { font-size: ${11.5 * scale}px !important }`,
    })
    console.log(`\n── ${theme}, ${scale}× ──`)
    for (const [name, selector, expected] of ROWS) {
      const box = await page.evaluate((sel) => {
        const row = document.querySelector(sel)
        if (!row) return null
        // A wrapped row would put the label's first letter on another line than the glyph's.
        row.style.whiteSpace = "nowrap"
        row.scrollIntoView({ block: "center" })
        const r = row.getBoundingClientRect()
        const cs = getComputedStyle(row)
        // A row with a fill of its own (a callout's title was one, in a header strip, until 2026-11-16) is read INSIDE that fill: from just
        // left of the glyph, over the text line only, so neither the strip's rounded corner, its padding
        // nor its hairline is mistaken for ink. The glyph is the `::before`, first in the row, so its
        // box starts at the content edge plus its own (negative) margin.
        const washed = cs.backgroundColor !== "rgba(0, 0, 0, 0)"
        const glyphLeft = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + parseFloat(getComputedStyle(row, "::before").marginLeft)
        const lineTop = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
        const lineHeight = r.height - parseFloat(cs.borderTopWidth) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth)
        const font = parseFloat(cs.fontSize)
        return washed
          ? { washed, x: glyphLeft + scrollX, y: lineTop + scrollY, w: 160, h: lineHeight, font }
          : { washed, x: r.left + scrollX, y: r.top + scrollY, w: Math.min(r.width, 320), h: r.height, font }
      }, selector)
      if (!box) {
        failures.push(`${name}: no element matched ${selector}`)
        continue
      }
      // Let the chevron's quarter-turn finish before a section that was just laid out is read.
      await new Promise((r) => setTimeout(r, 250))
      const PAD = 3
      const padY = box.washed ? 0 : PAD
      const b64 = await page.screenshot({
        clip: { x: box.x - PAD, y: box.y - padY, width: box.w + PAD * 2, height: box.h + padY * 2 },
        encoding: "base64",
        captureBeyondViewport: true,
      })
      const ink = await page.evaluate(async (data) => {
        const img = new Image()
        img.src = "data:image/png;base64," + data
        await img.decode()
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext("2d", { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        const bg = [d[0], d[1], d[2]]
        const dist = (x, y) => {
          const i = (y * c.width + x) * 4
          return Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2])
        }
        const colPeak = []
        for (let x = 0; x < c.width; x++) {
          let peak = 0
          for (let y = 0; y < c.height; y++) peak = Math.max(peak, dist(x, y))
          colPeak.push(peak)
        }
        // A mark: the next unbroken run of columns carrying any ink, then its edges at half its peak.
        const mark = (from) => {
          let start = from
          while (start < c.width && colPeak[start] <= 10) start++
          if (start >= c.width) return null
          let end = start
          while (end + 1 < c.width && colPeak[end + 1] > 10) end++
          let peak = 0
          for (let x = start; x <= end; x++) peak = Math.max(peak, colPeak[x])
          const half = peak / 2
          let left = -1, right = -1, top = -1, bottom = -1
          for (let x = start; x <= end; x++) {
            for (let y = 0; y < c.height; y++) {
              if (dist(x, y) <= half) continue
              if (left < 0) left = x
              right = x
              if (top < 0 || y < top) top = y
              if (y > bottom) bottom = y
            }
          }
          return { left, right: right + 1, top, bottom: bottom + 1, next: end + 1 }
        }
        const glyph = mark(0)
        const letter = glyph && mark(glyph.next)
        return { glyph, letter }
      }, b64)
      if (!ink.glyph || !ink.letter) {
        failures.push(`${name}: could not split the row into a glyph and a letter`)
        continue
      }
      const px = (n) => n / DSF
      const centre = (m) => (m.top + m.bottom) / 2
      const vertical = px(centre(ink.letter) - centre(ink.glyph))
      const gap = px(ink.letter.left - ink.glyph.right)
      const w = px(ink.glyph.right - ink.glyph.left)
      const h = px(ink.glyph.bottom - ink.glyph.top)
      const want = expected.map((em) => em * box.font)
      const cap = px(ink.letter.bottom - ink.letter.top)
      console.log(
        `${name.padEnd(24)} ${box.font.toFixed(1).padStart(5)}px  vertical ${vertical.toFixed(2).padStart(6)}px`
        + `  inkGap ${gap.toFixed(2).padStart(5)}px (${(gap / box.font).toFixed(3)}em)`
        + `  ink ${w.toFixed(2)}×${h.toFixed(2)} (geometry ${want[0].toFixed(2)}×${want[1].toFixed(2)})`
        + `  cap ${cap.toFixed(2)}  row ${box.h.toFixed(2)}`,
      )
      // The gate is the shipped size's; at 2× the same em error is twice the pixels.
      if (Math.abs(vertical) > TOL_PX * scale) failures.push(`${name} @${scale}×: glyph ${vertical.toFixed(2)}px off the cap band's centre`)
      // 0.6px, not less: a box whose size is not a whole pixel is painted on the nearest one, so the
      // 11.5px glyph of an answer chip is drawn 11 or 12 across and its ink is up to 0.5px off geometry.
      if (Math.abs(w - want[0]) > 0.6 * scale || Math.abs(h - want[1]) > 0.6 * scale) {
        failures.push(`${name} @${scale}×: ink ${w.toFixed(2)}×${h.toFixed(2)} is not the glyph's geometry ${want[0].toFixed(2)}×${want[1].toFixed(2)} — instrument or mask is off`)
      }
    }
    if (tag) await tag.evaluate((el) => el.remove())
  }
} finally {
  await browser.close()
}
if (failures.length) {
  console.error(`\nFAIL\n  ${failures.join("\n  ")}`)
  process.exitCode = 1
} else console.log("\nok")
