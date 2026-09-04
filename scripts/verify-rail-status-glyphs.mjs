// OPTICAL WEIGHT OF THE SIDEBAR RAIL'S STATUS GLYPHS (and a printed centring reading beside it).
//
// The rail is a checkbox family: every thread state is the SAME rounded-rect box (StatusBox, 15px) with
// a different mark inside. Four such marks already shipped — the ellipsis, the check, the "?" and the
// "!" — and 2026-08-01 added a fifth, the pulsing blue dot for "at rest, but work it launched is still
// running". (A sixth — a coloured mark for a standing/scheduled wake — shipped and was pulled the same
// day, 2026-08-02: the rail is read for what a thread is DOING, and a thread that will be re-prompted the
// moment it stops is simply WORKING. This script measured it while it existed and it was both the widest
// and half again the heaviest mark in the column, which is worth remembering if the slot is ever refilled.)
// A dot is the one mark that can
// silently wreck that column: a SOLID disc is far heavier per unit of diameter than an outlined glyph, so
// a dot sized to look right in isolation reads as the loudest thing in the rail.
// `.md-task-in-progress` measured exactly this for the same box (0.4 of the
// box → 12.65% ink against the check's 5.81%; 0.31 → ~7.5%, inside the family), and this script is what
// holds the rail itself to that finding instead of trusting an eyeball.
//
// It has to be a PIXEL measurement. `getBoundingClientRect` returns the same numbers whether a mark is
// centred or hard against a wall, and it is blind to everything painted outside the geometry — the
// box-shadow halo the transcript's dot carries is a THIRD of that mark's painted width and no DOM
// reading mentions it (scripts/ink-pixels.mjs exists for the same reason).
//
// Method, borrowed from verify-md-task-glyph-centering.mjs: hide the box's border so only the inner
// mark paints, screenshot each box at a high deviceScaleFactor, and take the ink bbox + inked-pixel
// count of what is left. The border is symmetric, so the border box's centre IS the interior's.
//
// The rail's glyphs are pinned in px (lucide at 10/15, a 15px box), so unlike the md-task family they
// cannot be measured at a blown-up size — hence a high DSF instead, where one CSS pixel is 8 device
// pixels and the coverage ratio is not quantisation noise. The `__calibration__` row is centred by
// CONSTRUCTION at the same size: if IT does not measure centred, the instrument is off at this scale
// and the run fails rather than quietly subtracting a bogus offset.
//
// Usage: nub scripts/verify-rail-status-glyphs.mjs --url=http://localhost:5261/rail-status-glyphs-fixture.html
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url", "http://localhost:5261/rail-status-glyphs-fixture.html")
const shots = opt("shots")
const DSF = Number(opt("dsf", "8"))
const BOX = 15
// No mark may TOWER inside its box — the same ceiling verify-md-task-glyph-centering.mjs enforces.
const MAX_EXTENT = 0.62
// `working` is the BoxSpinner, which is not a mark standing inside the box — it IS the box, traced. It
// has no separate border to hide, so it necessarily measures as a full-extent, perimeter-weight mark.
// Reported for reference; the family it belongs to is the box outline, not the glyphs inside one.
const UNGATED = new Set(["working"])
// THE MARK UNDER TEST. The gate is deliberately RELATIVE — "the dot must not become the heaviest or the
// lightest thing in the column" — rather than an absolute coverage band, for two reasons. The rail's
// pre-existing marks already span 2.4× (the hourglass is a dense multi-stroke glyph; the "!" is one
// stroke), so an absolute band would either fail states this change never touched or be so wide it
// asserts nothing. And the actual design question for a NEW mark is exactly the relative one: a solid
// disc is far heavier per unit of diameter than an outlined glyph, so a dot sized by eye lands outside
// the family it has to join. MEASURED, as the control for this gate: the transcript's own 6px dot with
// its halo — 0.4 of the box — covered 22.53%, against an existing ceiling of 9.42% and level with the
// entire spinner outline at 22.96%. It was the loudest thing in the rail. 0.31 with no halo puts it at
// 9.00%, just under the hourglass.
const UNDER_TEST = "background"
// THE HALF-PIXEL TRAP, measured 2026-08-02 and the reason the rail's coloured glyph looked off-centre. StatusBox
// is 15px with a 1px border and border-box sizing, so its CONTENT is 13px — an ODD number. Centring an
// EVEN-sized glyph in it leaves 1.5px a side, the glyph starts on a half pixel, and the rasteriser pushes
// its ink half a pixel right and down. That is not noise: on a 15px mark it is the whole complaint the
// maintainer raised ("the heartbeat icon is not optically centered", of that since-removed mark), and no geometry reading shows it —
// getBoundingClientRect on the SVG's paths reports a dead-centred mark either way. An odd size lands on
// the grid and measures centred, which is why every mark here is 9 or 11 and none is 10.
// EXEMPT: `done`/`archived` wear the Check at 10 and have shipped that way for months, carrying the same
// 0.5px offset. It is a real instance of this bug on a mark nobody has complained about, and resizing a
// shipped glyph is a design change, not a fix — so it is named here rather than silently corrected.
const ODD_SIZE_EXEMPT = new Set(["done", "archived"])

const { default: puppeteer } = await import("puppeteer")
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const failures = []
const rows = []
let bias = { dx: 0, dy: 0 }
try {
  const page = await browser.newPage()
  const pageErrors = []
  // Bare fixture pages declare no favicon, so vite 404s the browser's request for it. That is a property
  // of every fixture here, not of the thing under test.
  const isFaviconNoise = (t) => /favicon\.ico/.test(t) || /404 \(Not Found\)/.test(t)
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error" && !isFaviconNoise(m.text())) pageErrors.push(m.text()) })
  await page.setViewport({ width: 900, height: 400, deviceScaleFactor: DSF })
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 })
  await page.waitForSelector("[data-rail-glyph]", { timeout: 20_000 })

  // FREEZE the pulse at its brightest instant. Sampling a random phase makes two runs incomparable, and
  // a dot caught at its 0.45 trough measures as a lighter mark than the one that ships.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el)
      if (cs.animationName !== "none") { el.style.animationDelay = "0s"; el.style.animationPlayState = "paused" }
    }
  })
  // A reference centred by CONSTRUCTION, at the shipped box size, on the same surface.
  await page.evaluate((box) => {
    const host = document.querySelector("[data-rail-glyphs]")
    const cal = document.createElement("span")
    cal.setAttribute("data-rail-glyph", "__calibration__")
    cal.style.cssText = `position:relative;display:inline-flex;width:${box}px;height:${box}px;border:1px solid transparent;box-sizing:border-box;margin:0 10px`
    cal.innerHTML = `<i style="position:absolute;inset:0;margin:auto;width:${box * 0.4}px;height:${box * 0.4}px;background:#8b8f96"></i>`
    host.prepend(cal)
  }, BOX)
  await new Promise((r) => setTimeout(r, 200))

  // Read every mark's rendered glyph size straight off the DOM before the pixel pass — the odd-size rule
  // is a property of the markup, not of the capture, so it is checked where it is cheap and exact.
  //
  // NOT JUST THE SVGs. This read `[data-rail-glyph] svg` alone until 2026-09-04, so the one mark in the
  // family that is NOT an SVG — the background dot, a bare <span> — was never gated, and it had been
  // shipping at `calc(15px * 0.31)` = 4.65px: the exact defect the rule below describes, in the exact
  // place the rule was written to prevent it (maintainer: "this is also not perfectly centered"). Any
  // mark that stands INSIDE the box is measured now, whatever element draws it.
  const sizes = await page.$$eval("[data-rail-glyph] svg, [data-rail-glyph] .frizz-rail-dot", (marks) =>
    marks.map((s) => ({ name: s.closest("[data-rail-glyph]").getAttribute("data-rail-glyph"), w: s.getBoundingClientRect().width })),
  )
  for (const { name, w } of sizes) {
    if (ODD_SIZE_EXEMPT.has(name) || UNGATED.has(name)) continue
    if (!Number.isInteger(w) || w % 2 !== 1) failures.push(`${name} draws a ${w}px glyph — anything but an ODD whole number centres onto a half pixel in the 13px content box, and its ink lands 0.5px right and down`)
  }

  const names = await page.$$eval("[data-rail-glyph]", (els) => els.map((e) => e.getAttribute("data-rail-glyph")))
  for (const name of names) {
    const sel = `[data-rail-glyph="${name}"]`
    // Hide the box's border so ONLY the inner mark paints — its ink box is then unambiguous. The
    // attribute sits on the tooltip wrapper, so the border to hide is on a DESCENDANT (StatusBox).
    await page.evaluate((s) => {
      for (const el of [document.querySelector(s), ...document.querySelectorAll(`${s} *`)]) el.style.borderColor = "transparent"
    }, sel)
    await new Promise((r) => setTimeout(r, 60))
    const buf = await (await page.$(sel)).screenshot({ encoding: "base64" })
    await page.evaluate((s) => {
      for (const el of [document.querySelector(s), ...document.querySelectorAll(`${s} *`)]) el.style.borderColor = ""
    }, sel)

    const ink = await page.evaluate(async (b64, dsf) => {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}` })
      const c = document.createElement("canvas")
      c.width = img.width; c.height = img.height
      const ctx = c.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, c.width, c.height)
      const bg = [data[0], data[1], data[2]]
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4
          const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])
          if (d < 24) continue // antialias haze; a real mark is far brighter than this
          n++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
      if (!n) return null
      return {
        boxW: c.width / dsf, boxH: c.height / dsf,
        inkL: minX / dsf, inkR: (maxX + 1) / dsf, inkT: minY / dsf, inkB: (maxY + 1) / dsf,
        // COVERAGE — inked device pixels over the box's area. This is the OPTICAL WEIGHT question, and a
        // bounding box cannot answer it: a solid disc and an outlined tick can share a bbox and read as
        // completely different amounts of mark.
        coverage: n / (c.width * c.height),
      }
    }, buf, DSF)

    if (!ink) { failures.push(`${name}: no ink found`); continue }
    // POSITIVE dx = the mark sits LEFT of centre and must move RIGHT; POSITIVE dy = ABOVE centre.
    const rawDx = (ink.boxW / 2 - (ink.inkL + ink.inkR) / 2) * (BOX / ink.boxW)
    const rawDy = (ink.boxH / 2 - (ink.inkT + ink.inkB) / 2) * (BOX / ink.boxH)
    if (name === "__calibration__") {
      bias = { dx: rawDx, dy: rawDy }
      console.log(`      calibration bias: right ${rawDx.toFixed(3)}px, down ${rawDy.toFixed(3)}px  (a mark centred by construction; every centre reading below is net of this)`)
      // NOT a failure here, and that is the difference from verify-md-task-glyph-centering.mjs. That
      // script can blow its box up to 160px, where one device pixel is a rounding error; the rail's
      // glyphs are pinned in px and cannot be scaled, so a fixed few-device-pixel element-screenshot
      // capture offset lands at ~0.5px however high the DSF goes. That is why CENTERING here is a
      // printed reading rather than a gate — it cannot resolve below its own noise floor, and pretending
      // otherwise would fail states this repo has shipped for months. The WEIGHT gate below is a ratio
      // of inked pixels within one capture, so the offset cancels and it stays trustworthy.
      continue
    }
    const dx = rawDx - bias.dx
    const dy = rawDy - bias.dy
    const row = {
      glyph: name,
      inkW: +((ink.inkR - ink.inkL) / ink.boxW).toFixed(3),
      inkH: +((ink.inkB - ink.inkT) / ink.boxH).toFixed(3),
      coverage: +(ink.coverage * 100).toFixed(2),
      nudgeRightPx: +dx.toFixed(3),
      nudgeDownPx: +dy.toFixed(3),
    }
    rows.push(row)
    const gated = !UNGATED.has(name)
    console.log(`      ${name.padEnd(24)} ink ${String(row.inkW).padEnd(5)}×${String(row.inkH).padEnd(5)}  cover ${String(row.coverage).padStart(5)}%  ·  centre off by right ${row.nudgeRightPx > 0 ? "+" : ""}${row.nudgeRightPx}px  down ${row.nudgeDownPx > 0 ? "+" : ""}${row.nudgeDownPx}px${gated ? "" : "   (spinner — reference only)"}`)
    if (gated && Math.max(row.inkW, row.inkH) > MAX_EXTENT) failures.push(`${name} fills ${Math.max(row.inkW, row.inkH)} of its box (max ${MAX_EXTENT}) — it crowds the walls`)
  }

  // THE GATE: the mark under test must sit INSIDE the weight range its neighbours already occupy.
  const inFamily = rows.filter((r) => !UNGATED.has(r.glyph))
  const mark = inFamily.find((r) => r.glyph === UNDER_TEST)
  const others = inFamily.filter((r) => r.glyph !== UNDER_TEST)
  if (!mark) failures.push(`the mark under test (${UNDER_TEST}) never rendered`)
  else {
    const hi = others.reduce((a, b) => (a.coverage > b.coverage ? a : b))
    const lo = others.reduce((a, b) => (a.coverage < b.coverage ? a : b))
    const ok = mark.coverage <= hi.coverage && mark.coverage >= lo.coverage
    console.log(`\n${ok ? "PASS" : "FAIL"}  ${UNDER_TEST} covers ${mark.coverage}% — the rest of the column runs ${lo.coverage}% (${lo.glyph}) … ${hi.coverage}% (${hi.glyph})`)
    if (mark.coverage > hi.coverage) failures.push(`${UNDER_TEST} at ${mark.coverage}% is now the HEAVIEST mark in the rail, over ${hi.glyph} at ${hi.coverage}%`)
    if (mark.coverage < lo.coverage) failures.push(`${UNDER_TEST} at ${mark.coverage}% is now the FAINTEST mark in the rail, under ${lo.glyph} at ${lo.coverage}%`)
  }
  console.log(`      largest extent ${Math.max(...inFamily.map((r) => Math.max(r.inkW, r.inkH))).toFixed(3)} of box (max ${MAX_EXTENT})`)

  if (shots) {
    mkdirSync(shots, { recursive: true })
    await (await page.$("[data-rail-glyphs]")).screenshot({ path: join(shots, "rail-status-glyphs.png") })
    console.log(`      shot → ${join(shots, "rail-status-glyphs.png")}`)
  }
  if (pageErrors.length) failures.push(`console/page errors: ${pageErrors.join(" | ")}`)
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\nthe new rail mark sits inside the weight band its neighbours already occupy, and nothing crowds its box")
process.exit(failures.length ? 1 : 0)
