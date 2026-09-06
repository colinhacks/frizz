// Measure the HORIZONTAL rhythm of a row of marks — the gaps the eye actually reads between them,
// and how loud each mark is.
//
// `ink-pixels.mjs` answers "how big does this one mark read" by scanning its centre row/column. That
// is the wrong instrument for a control strip, where the question is about the SPACE BETWEEN marks:
// a 24px borderless icon button and a bordered pill can sit on the same 6px flex gap and read as
// wildly different distances, because the icon wears ~7px of dead padding on each side and the pill's
// ink starts at its border. CSS `gap` is a box measurement; nobody looks at boxes.
//
// So this one takes an ORDERED list of elements, screenshots each with a small padded clip, unions
// EVERY row of the clip (not just the centre — a plug's ink and a chevron's ink peak on different
// rows) to find the leftmost and rightmost painted column, and converts back to absolute page CSS px.
// Adjacent ink edges then give the real gap. Whatever is painted counts: a border, a fill, a ring,
// a shadow — all of it is ink, because all of it is what the eye reads as the edge of the mark.
//
// It also reports each mark's MEAN ink contrast against the surface behind it, which is the reading
// to compare when marks in one cluster look like they carry different weight. Peak says how bright
// the brightest pixel is; mean says how loud the mark reads as a whole, and a thin bright stroke and
// a fat dim one can share a peak while reading nothing alike.
//
// Usage:
//   node scripts/ink-gaps.mjs <url> "<sel-a>,<sel-b>,…" [--dsf=4] [--w=1100] [--h=700] [--wait=2200]
//     [--pad=2] [--threshold=8] [--before=@/tmp/routine.js] [--hover=<css selector>]
//     [--software] [--viewport-only] (for a stalled GPU compositor; keep the whole row in the viewport)
//
// Selectors are measured in the order given (NOT document order), so the printed gaps follow the
// strip left to right exactly as you name it. `--hover` parks the pointer on an element first (after
// `--before`), for a strip that only exists on CSS :hover — a rail row's actions — which no in-page
// expression can reveal.
import { readFileSync } from "node:fs"
import puppeteer from "puppeteer"

const args = process.argv.slice(2)
const pos = args.filter((a) => !a.startsWith("--"))
// Split on the FIRST "=" only. A --clip selector ([data-x="y"]) and an inline --before expression both
// carry their own "=", and a naive split("=") silently truncated the value to everything before it —
// so the flag became a no-op and the run produced a confident, wrong screenshot rather than an error.
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const s = a.replace(/^--/, ""); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }))
const [url, selectorList] = pos
if (!url || !selectorList) {
  console.error('usage: node scripts/ink-gaps.mjs <url> "<sel-a>,<sel-b>,…" [--dsf=4] [--pad=2] [--before=@file]')
  process.exit(1)
}
const DSF = Number(flags.dsf) || 4
const W = Number(flags.w) || 1100
const H = Number(flags.h) || 700
const WAIT = Number(flags.wait) || 2200
const PAD = flags.pad === undefined ? 2 : Number(flags.pad)
const THRESHOLD = Number(flags.threshold) || 8
const selectors = selectorList.split(",").map((s) => s.trim()).filter(Boolean)

// protocolTimeout: puppeteer's default is 180s, and `Page.captureScreenshot` blows straight through it
// on a busy machine — this repo regularly has a dozen agents compiling at once (measured at load
// average 159, where a single 390×844 dsf-2 shot of a page with backdrop-blur could not rasterize in
// three minutes). The failure arrives as a bare ProtocolError that reads like a bug in the page.
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--force-color-profile=srgb", ...(flags.software ? ["--disable-gpu"] : [])],
  protocolTimeout: 600_000,
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: DSF })
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 })
  await new Promise((r) => setTimeout(r, WAIT))
  if (flags.before) {
    const expr = flags.before.startsWith("@") ? readFileSync(flags.before.slice(1), "utf8") : flags.before
    await page.evaluate(expr)
  }
  if (flags.hover) await page.hover(flags.hover)

  const boxes = await page.evaluate((sels) => {
    return sels.map((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      // Freeze anything animated at the start of its cycle, so two runs sample the same instant.
      for (const a of el.getAnimations()) {
        a.pause()
        a.currentTime = 0
      }
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height, box: [+r.width.toFixed(2), +r.height.toFixed(2)] }
    })
  }, selectors)

  const missing = selectors.filter((s, i) => !boxes[i])
  if (missing.length) {
    console.error(`no element matched: ${missing.join(", ")}`)
    process.exit(1)
  }

  const marks = []
  for (const [i, b] of boxes.entries()) {
    const b64 = await page.screenshot({
      clip: { x: b.x - PAD, y: b.y - PAD, width: b.w + PAD * 2, height: b.h + PAD * 2 },
      encoding: "base64",
      captureBeyondViewport: !flags["viewport-only"],
    })
    const ink = await page.evaluate(async (data, threshold) => {
      const img = new Image()
      img.src = "data:image/png;base64," + data
      await img.decode()
      const c = document.createElement("canvas")
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]] }
      // The surface behind the mark, read from the clip's corner rather than assumed — the strip may
      // be tinted, hovered, or inside a card with its own background.
      const bg = at(0, 0)
      const dist = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2])
      let first = -1
      let last = -1
      let sum = 0
      let count = 0
      let peak = 0
      let top = -1
      let bottom = -1
      for (let x = 0; x < c.width; x++) {
        let hit = false
        for (let y = 0; y < c.height; y++) {
          const v = dist(at(x, y))
          if (v <= threshold) continue
          hit = true
          sum += v
          count++
          if (v > peak) peak = v
          if (top < 0 || y < top) top = y
          if (y > bottom) bottom = y
        }
        if (!hit) continue
        if (first < 0) first = x
        last = x
      }
      return {
        first,
        last,
        w: first < 0 ? 0 : last - first + 1,
        h: top < 0 ? 0 : bottom - top + 1,
        mean: count ? +(sum / count).toFixed(1) : 0,
        peak,
        coverage: count ? +(count / (c.width * c.height)).toFixed(3) : 0,
      }
    }, b64, THRESHOLD)
    marks.push({
      selector: selectors[i],
      boxCssPx: b.box,
      // Absolute page coordinates of the painted edges — this is what makes the gaps below real.
      inkLeft: +(b.x - PAD + ink.first / DSF).toFixed(2),
      inkRight: +(b.x - PAD + (ink.last + 1) / DSF).toFixed(2),
      inkCssPx: [+(ink.w / DSF).toFixed(2), +(ink.h / DSF).toFixed(2)],
      // Dead space between the layout box and the painted mark, per side. This is the number that
      // explains an inconsistent-looking strip: a mark with 7px of it needs 7px less `gap`.
      deadLeft: +(b.x - PAD + ink.first / DSF - b.x).toFixed(2),
      deadRight: +(b.x + b.w - (b.x - PAD + (ink.last + 1) / DSF)).toFixed(2),
      meanContrast: ink.mean,
      peakContrast: ink.peak,
      inkCoverage: ink.coverage,
    })
  }

  const gaps = marks.slice(1).map((m, i) => ({
    between: `${marks[i].selector} → ${m.selector}`,
    boxGap: +(m.boxCssPx && marks[i] ? 0 : 0).toFixed(2),
    inkGap: +(m.inkLeft - marks[i].inkRight).toFixed(2),
  }))
  for (const [i, g] of gaps.entries()) {
    const prev = boxes[i]
    g.boxGap = +(boxes[i + 1].x - (prev.x + prev.w)).toFixed(2)
  }
  console.log(JSON.stringify({ marks, gaps }, null, 2))
} finally {
  await browser.close()
}
