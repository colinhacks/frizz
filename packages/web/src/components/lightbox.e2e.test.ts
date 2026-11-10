import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { crc32, deflateSync } from "node:zlib"

// What the page's fixture (lightbox-fixture.tsx) puts on `window`.
declare global {
  interface Window { __pageKeys?: string[]; __chips?: number[]; __sheetPicks?: number[] }
}

// Runtime coverage for the ```lightbox fence (components/Lightbox.tsx): the gallery's justified rows,
// the viewer's paging and dismissal, its zoom under a mouse and under fingers, the gallery on the cards
// that render prose as one string of HTML, a loose picture opening the same viewer — and the three things
// only a browser settles: that an Escape the viewer handled never reaches the page (where it would unwind
// a drawer or leave the fullscreen page), that focus comes back to the picture that opened it, and that
// a phone's Back closes the viewer rather than leaving the page. Skipped unless a Vite URL serving the
// fixtures is provided: start `vite` in packages/web and set FRIZZ_LIGHTBOX_E2E_URL to its origin (or run
// `nub run test:e2e`, which does both).
//
// The pictures are drawn HERE. A plain Vite has no /_frizz/local-image route, so the test intercepts it
// and answers with a PNG of the size the fixture's path names; `missing` paths get the real route's 404.
// A `.webm` gets CLIP — 1.5s of ffmpeg's `testsrc2` at 320×180, VP9, which every Chrome decodes — in the
// byte ranges a <video> asks for, as the real route answers them (server/local-image.ts).
const baseUrl = process.env.FRIZZ_LIGHTBOX_E2E_URL
const CLIP = readFileSync(new URL("./lightbox-e2e-clip.webm", import.meta.url))

// A solid-colour RGB PNG of the given size — enough to give the gallery real shapes to lay out.
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit, truecolour, deflate, no filter, no interlace
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([60, 90, 140], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const DESKTOP = { width: 1000, height: 900, deviceScaleFactor: 1 }
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
// Every gallery tile on the fixture page: 2 + 3 + 2 + 2 + 1 in the transcript's galleries (the missing
// file is listed, not tiled), 2 in the done card and 2 in the question option. One of them is a video.
const TILES = 14
const VIDEO_TILES = 1

async function launch(viewport: typeof DESKTOP | typeof PHONE = DESKTOP) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport(viewport)
  const errors: string[] = []
  // The deliberately missing picture's 404 is the one expected failure.
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setRequestInterception(true)
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname !== "/_frizz/local-image") return void request.continue()
    const path = url.searchParams.get("path") ?? ""
    if (path.endsWith(".webm")) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "")
      if (!range) return void request.respond({ status: 200, contentType: "video/webm", headers: { "accept-ranges": "bytes" }, body: CLIP })
      const start = Number(range[1])
      const end = range[2] ? Math.min(Number(range[2]), CLIP.length - 1) : CLIP.length - 1
      return void request.respond({
        status: 206,
        contentType: "video/webm",
        headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${CLIP.length}` },
        body: CLIP.subarray(start, end + 1),
      })
    }
    const size = /-(\d+)x(\d+)\.png$/.exec(path)
    if (!size || path.includes("missing")) return void request.respond({ status: 404, body: "404" })
    void request.respond({ status: 200, contentType: "image/png", body: png(Number(size[1]), Number(size[2])) })
  })
  await page.goto(new URL("/lightbox-fixture.html", baseUrl).href, { waitUntil: "networkidle2" })
  // Every picture settled — decoded, or failed and dropped — every video's shape known, and the rows
  // re-justified on real shapes.
  await page.waitForFunction((tiles, videos) =>
    document.querySelectorAll("[data-lightbox-tile]").length === tiles
    && document.querySelectorAll<HTMLVideoElement>("[data-lightbox-tile] video").length === videos
    && [...document.querySelectorAll<HTMLVideoElement>("[data-lightbox-tile] video")].every((v) => v.readyState >= 1 && v.videoWidth > 0)
    && [...document.images].every((img) => img.complete && img.naturalWidth > 0), {}, TILES, VIDEO_TILES)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return { browser, page, errors }
}

type Page = Awaited<ReturnType<typeof launch>>["page"]

const viewer = (page: Page) => page.evaluate(() => {
  const v = document.querySelector("[data-lightbox]")
  if (!v) return null
  return {
    counter: v.querySelector("[data-lightbox-counter]")?.textContent ?? null,
    title: v.querySelector("h2")?.textContent ?? null,
    caption: v.querySelector("[data-lightbox-caption]")?.textContent ?? null,
    picture: decodeURIComponent(v.querySelector("img")?.getAttribute("src")?.split("path=")[1] ?? ""),
  }
})

const pageKeys = (page: Page) => page.evaluate(() => window.__pageKeys!.splice(0))

// The viewer's picture once its zoom has SETTLED. The inline transform is the target a change sets and
// the computed one trails it through the 180ms ease, so this waits for the ease to END before reading.
// Ended, and not merely close: the ease spends its last frames within a thousandth of the target, and a
// rect read there is not the settled one. Measured 2026-10-11 with the animation slowed 50×: the first
// frame the two agreed to a thousandth drew the 872px picture 872.85px wide at left 63.57 instead of 64,
// with the transition still running — enough to round a point 30% across to 325 instead of 326, which is
// the "pixel under the cursor moved" the pinch test reported twice at a load average over 260.
// `rect` is where the picture is drawn; `fitted` is its layout box, which a transform does not move.
async function zoomOf(page: Page) {
  const read = () => {
    const img = document.querySelector<HTMLImageElement>("[data-lightbox] img")
    const m = img && /translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/.exec(img.style.transform)
    if (!img || !m) return null
    const [x, y, scale] = m.slice(1).map(Number)
    const c = new DOMMatrix(getComputedStyle(img).transform)
    const settled = img.getAnimations().length === 0 && Math.abs(c.a - scale) < 1e-3 && Math.abs(c.e - x) < 0.05 && Math.abs(c.f - y) < 0.05
    const r = img.getBoundingClientRect()
    return { settled, scale, x, y, rect: { left: r.left, top: r.top, width: r.width, height: r.height } }
  }
  await page.waitForFunction(`(${read})()?.settled`, { timeout: 5000 })
  return (await page.evaluate(read))!
}

// The viewer's picture, READY for a gesture — which `waitForSelector`, returning as soon as the <img>
// exists, does not mean. Two things trail it. The picture must have LOADED: a gesture zooms only once it
// knows its natural size (`geometry()` in Lightbox.tsx is null until then). And the dialog must be TAKING
// THE POINTER: Radix turns `pointer-events` off on <body> as a modal mounts and back on for the dialog's
// content one render later, and in between a click at the picture lands on the scrim behind it and zooms
// nothing. Nobody clicks inside that window by hand; a driver does. Measured 2026-10-11 on the click
// test's second picture, which is cached and so loaded at once: its click arrived 16ms after the tile's
// and its target was the scrim, in 2 of 5 runs under the headless shell, which dispatches input without
// waiting for a frame the way the full browser did (0 of 6 there).
const pictureReady = (page: Page) =>
  page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>("[data-lightbox] img")
    return !!img && img.naturalWidth > 0 && getComputedStyle(img).pointerEvents !== "none"
  })

const close = (a: number, b: number, tolerance = 0.5) => Math.abs(a - b) <= tolerance
// A browser serializes a transform's numbers to six significant digits, so a scale read back from one is
// compared to that precision, and a movement — a difference of two translations — to a hundredth of a
// pixel.
const sameScale = (a: number, b: number) => Math.abs(a / b - 1) < 1e-5
const px2 = (v: number) => +v.toFixed(2)

test("a lightbox fence lays its pictures out in justified rows at their real shapes", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const galleries = await page.$$eval("[data-fixture-message] [data-lightbox-gallery]", (els) => els.map((gallery) => {
      const width = gallery.getBoundingClientRect().width
      return {
        width,
        rows: [...gallery.querySelectorAll("[data-lightbox-row]")].map((row) => ({
          width: row.getBoundingClientRect().width,
          pictures: [...row.querySelectorAll("img")].map((img) => {
            const box = img.getBoundingClientRect()
            return { w: box.width, h: box.height, ratio: img.naturalWidth / img.naturalHeight }
          }),
        })),
        missing: [...gallery.querySelectorAll("[data-lightbox-missing]")].map((el) => el.textContent),
      }
    }))
    assert.equal(galleries.length, 5)
    // The three widths of one page share ONE row, at one height, each at its own shape, edge to edge.
    const [widths] = galleries[1].rows
    assert.equal(galleries[1].rows.length, 1)
    assert.equal(widths.pictures.length, 3)
    for (const picture of widths.pictures) {
      assert.ok(Math.abs(picture.h - widths.pictures[0].h) < 0.5, `heights differ: ${JSON.stringify(widths.pictures)}`)
      assert.ok(Math.abs(picture.w / picture.h - picture.ratio) < 0.02, `a picture was stretched: ${JSON.stringify(picture)}`)
    }
    assert.ok(Math.abs(widths.width - galleries[1].width) < 0.5, "the row spans the frame")
    // The missing file is listed as its path, and only the two real pictures take a place in the rows.
    assert.deepEqual(galleries[2].missing, ["/fixture/lightbox/missing-1440x900.png"])
    assert.equal(galleries[2].rows.flatMap((row) => row.pictures).length, 2)
    // A tile is a button named by what is in it. Under a caption that is the caption, once: the picture
    // carries no alt there. With no caption drawn, the picture's alt is the only name the button has.
    const names = await page.$$eval("[data-lightbox-tile]", (tiles) => tiles.flatMap((tile) => {
      const picture = tile.querySelector("img")
      if (!picture) return [] // a video's frame is hidden from the name already
      const caption = [...tile.querySelectorAll("span")].find((span) => span.title)?.textContent ?? null
      return [{ caption, alt: picture.alt }]
    }))
    const captioned = names.filter((name) => name.caption !== null)
    const bare = names.filter((name) => name.caption === null)
    assert.ok(captioned.length > 0 && bare.length > 0, `the fixture has both kinds of gallery: ${JSON.stringify(names)}`)
    assert.deepEqual(captioned.filter((name) => name.alt !== ""), [], "a captioned tile says its caption twice")
    assert.deepEqual(bare.filter((name) => name.alt === ""), [], "an uncaptioned tile has no name at all")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the viewer pages with the arrow keys, stops at the ends, and Escape closes it without reaching the page", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const tiles = await page.$$("[data-fixture-message='0'] [data-lightbox-tile]")
    await tiles[1].click() // "After", the second of the first gallery
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: "2 / 2", title: "after-1440x900.png", caption: "After", picture: "/fixture/lightbox/after-1440x900.png" })
    await page.keyboard.press("ArrowRight")
    assert.equal((await viewer(page))?.counter, "2 / 2", "the last picture is the end, not a wrap")
    await page.keyboard.press("ArrowLeft")
    assert.deepEqual(await viewer(page), { counter: "1 / 2", title: "before-1440x900.png", caption: "Before", picture: "/fixture/lightbox/before-1440x900.png" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(await pageKeys(page), [], "a key the viewer handled must not reach the page")
    // Radix hands focus back one task AFTER the dialog unmounts (its focus scope restores on a timeout),
    // so wait for it to land on a tile before asserting which one.
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-lightbox-tile"), { timeout: 5000 })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "View After", "focus returns to the opener")
    // The control: with the viewer closed, the same key does reach the page listener.
    await page.keyboard.press("Escape")
    assert.deepEqual(await pageKeys(page), ["Escape"])

    // A gallery with a missing file pages through the pictures that are there.
    const third = await page.$$("[data-fixture-message='2'] [data-lightbox-tile]")
    await third[0].click()
    await page.waitForSelector("[data-lightbox]")
    assert.equal((await viewer(page))?.counter, "1 / 2")
    await page.keyboard.press("End")
    assert.equal((await viewer(page))?.picture, "/fixture/lightbox/last-1440x900.png")
    await page.keyboard.press("Home")
    assert.equal((await viewer(page))?.picture, "/fixture/lightbox/first-1440x900.png")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// The header's buttons are the thread header's icon controls (lib/headerIcon.ts), named by its immediate
// tooltip. A tooltip that is open is a layer ABOVE the dialog, so it takes Escape from it — and the key
// then has to close the viewer from the dialog's own handler, or it closes only the tooltip and reaches
// the page with the viewer still up.
test("the header's buttons are the thread header's squares with its tooltips, and Escape over a tooltip still closes the viewer", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await (await page.$("[data-fixture-message='0'] [data-lightbox-tile]"))!.click()
    await pictureReady(page)
    const buttons = await page.$$eval("[data-lightbox] header button", (els) => els.map((b) => {
      const box = b.getBoundingClientRect()
      return [b.getAttribute("aria-label"), box.width, box.height, b.querySelector("svg")!.getBoundingClientRect().width]
    }))
    assert.deepEqual(buttons, [["Zoom out", 28, 28, 14], ["Zoom in", 28, 28, 14], ["Download", 28, 28, 14], ["Open in default viewer", 28, 28, 14], ["Close", 28, 28, 15]])

    await page.hover('[data-lightbox] button[aria-label="Open in default viewer"]')
    await page.waitForFunction(() => document.querySelector("[role=tooltip]")?.textContent === "Open in default viewer", { timeout: 5000 })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"), { timeout: 5000 })
    assert.deepEqual(await pageKeys(page), [], "the Escape that closed the viewer must not reach the page")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// The caption stays with its picture in the viewer, as it is under the picture's tile: directly beneath
// it, centred on it, and inside the stage, with the picture giving up the height it takes — a picture
// bound by the stage's HEIGHT is the case that shows it, since there the two would otherwise overlap.
test("a caption sits under the viewer's picture, steps aside while it is magnified, and Download saves the file", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  const dir = mkdtempSync(join(tmpdir(), "lightbox-download-"))
  try {
    const layout = () => page.evaluate(() => {
      const v = document.querySelector("[data-lightbox]")!
      const media = v.querySelector<HTMLImageElement | HTMLVideoElement>("[data-lightbox-stage] img, [data-lightbox-stage] video")!
      const caption = v.querySelector<HTMLElement>("[data-lightbox-caption]")
      const stage = v.querySelector<HTMLElement>("[data-lightbox-stage]")!
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
      const s = getComputedStyle(stage)
      const stageBox = box(stage)
      return {
        picture: box(media),
        natural: media instanceof HTMLImageElement ? media.naturalWidth / media.naturalHeight : media.videoWidth / media.videoHeight,
        caption: caption && { ...box(caption), lines: Math.round((caption.getBoundingClientRect().height - parseFloat(getComputedStyle(caption).paddingTop)) / parseFloat(getComputedStyle(caption).lineHeight)), opacity: getComputedStyle(caption).opacity },
        content: { top: stageBox.top + parseFloat(s.paddingTop), bottom: stageBox.bottom - parseFloat(s.paddingBottom) },
        describedBy: v.getAttribute("aria-describedby") === caption?.id,
      }
    })
    const assertUnder = (l: Awaited<ReturnType<typeof layout>>, what: string) => {
      const { picture, caption, content } = l
      assert.ok(caption, `${what}: no caption`)
      assert.ok(close(caption.top, picture.bottom), `${what}: the caption is not directly under the picture: ${JSON.stringify(l)}`)
      assert.ok(close(caption.left + caption.width / 2, picture.left + picture.width / 2), `${what}: the caption is off the picture's centre: ${JSON.stringify(l)}`)
      assert.ok(caption.bottom <= content.bottom + 0.5, `${what}: the caption runs past the stage: ${JSON.stringify(l)}`)
      assert.ok(close(picture.width / picture.height, l.natural, 0.01), `${what}: the picture was squashed: ${JSON.stringify(l)}`)
      // Picture and caption centre in the stage as one.
      assert.ok(close(picture.top - content.top, content.bottom - caption.bottom, 1), `${what}: the pair is not centred: ${JSON.stringify(l)}`)
      assert.ok(l.describedBy, `${what}: the dialog is not described by its caption`)
    }

    // A wide picture, bound by the stage's width.
    await (await page.$("[data-fixture-message='0'] [data-lightbox-tile]"))!.click()
    await pictureReady(page)
    const wide = await layout()
    assertUnder(wide, "wide")
    assert.equal(wide.caption!.lines, 1)

    // Magnified, the picture owns the stage and the caption steps aside — and comes back at fit.
    await page.mouse.click(wide.picture.left + wide.picture.width / 2, wide.picture.top + wide.picture.height / 2)
    assert.ok((await zoomOf(page)).scale > 1)
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-lightbox-caption]")!).opacity === "0", { timeout: 5000 })
    assert.equal(await page.$eval("[data-lightbox-caption]", (el) => getComputedStyle(el).pointerEvents), "none")
    await page.keyboard.press("0")
    assert.equal((await zoomOf(page)).scale, 1)
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-lightbox-caption]")!).opacity === "1", { timeout: 5000 })

    // A click on the caption is not a click on the backdrop: the viewer stays open.
    const caption = (await (await page.$("[data-lightbox-caption]"))!.boundingBox())!
    await page.mouse.click(caption.x + caption.width / 2, caption.y + caption.height - 4)
    await new Promise((r) => setTimeout(r, 200))
    assert.notEqual(await viewer(page), null, "a click on the caption closed the viewer")

    // Download saves the picture under its file's own name, byte for byte.
    const session = await browser.target().createCDPSession()
    await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true })
    const began = new Promise<string>((resolve) => session.on("Browser.downloadWillBegin", (e) => resolve(e.suggestedFilename)))
    const finished = new Promise<string>((resolve) => session.on("Browser.downloadProgress", (e) => { if (e.state !== "inProgress") resolve(e.state) }))
    await page.click('[data-lightbox] button[aria-label="Download"]')
    assert.equal(await began, "before-1440x900.png")
    assert.equal(await finished, "completed")
    assert.ok(readFileSync(join(dir, "before-1440x900.png")).equals(png(1440, 900)), "the download is not the picture's bytes")
    assert.notEqual(await viewer(page), null, "downloading closed the viewer")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))

    // A tall picture, bound by the stage's height, under a caption that wraps: the picture shortens by
    // the caption's height and the caption still sits under it, inside the stage.
    await (await page.$("[data-fixture-message='4'] [data-lightbox-tile]"))!.click()
    await pictureReady(page)
    const tall = await layout()
    assertUnder(tall, "tall")
    assert.ok(close(tall.caption!.bottom, tall.content.bottom), `the tall picture does not take the stage's height: ${JSON.stringify(tall)}`)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))

    // An uncaptioned picture has no caption and reserves nothing: the 812px phone shot fits the 828px
    // stage at its own size, centred.
    await (await page.$("[data-fixture-message='1'] [data-lightbox-tile]"))!.click() // phone-375x812
    await pictureReady(page)
    const bare = await layout()
    assert.equal(bare.caption, null)
    assert.equal(await page.$eval("[data-lightbox-stage] img", (img) => (img as HTMLElement).style.maxHeight), "")
    assert.ok(close(bare.picture.height, 812) && close(bare.picture.top - bare.content.top, bare.content.bottom - bare.picture.bottom),
      `an uncaptioned picture lost height: ${JSON.stringify(bare)}`)
    assert.equal(await page.$eval("[data-lightbox]", (v) => v.hasAttribute("aria-describedby")), false)
    assert.deepEqual(errors, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await browser.close()
  }
})

// On a phone the stage is narrow, so the long caption wraps over several lines — and still sits under the
// picture, which shrinks to leave it room.
test("on a phone, a caption that wraps still sits under the picture, inside the stage", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch(PHONE)
  try {
    for (const message of ["0", "4"]) {
      await (await page.$(`[data-fixture-message='${message}'] [data-lightbox-tile]`))!.tap()
      await pictureReady(page)
      const l = await page.evaluate(() => {
        const v = document.querySelector("[data-lightbox]")!
        const img = v.querySelector<HTMLImageElement>("[data-lightbox-stage] img")!
        const caption = v.querySelector<HTMLElement>("[data-lightbox-caption]")!
        const stage = v.querySelector<HTMLElement>("[data-lightbox-stage]")!
        const p = img.getBoundingClientRect()
        const c = caption.getBoundingClientRect()
        const s = stage.getBoundingClientRect()
        return {
          ratio: p.width / p.height,
          natural: img.naturalWidth / img.naturalHeight,
          gap: c.top - p.bottom,
          centre: c.left + c.width / 2 - (p.left + p.width / 2),
          overflow: c.bottom - (s.bottom - parseFloat(getComputedStyle(stage).paddingBottom)),
          lines: Math.round((c.height - parseFloat(getComputedStyle(caption).paddingTop)) / parseFloat(getComputedStyle(caption).lineHeight)),
        }
      })
      assert.ok(close(l.gap, 0) && close(l.centre, 0) && l.overflow <= 0.5 && close(l.ratio, l.natural, 0.01), `message ${message}: ${JSON.stringify(l)}`)
      if (message === "4") assert.ok(l.lines >= 2, `the long caption did not wrap: ${JSON.stringify(l)}`)
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a click zooms into the point under the cursor, a drag moves the magnified picture, and a click zooms back out", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await (await page.$("[data-fixture-message='0'] [data-lightbox-tile]"))!.click()
    await pictureReady(page)
    const fit = await zoomOf(page)
    assert.deepEqual([fit.scale, fit.x, fit.y], [1, 0, 0])
    assert.equal(await page.$eval("[data-lightbox] img", (img) => getComputedStyle(img).cursor), "zoom-in")

    // About 30% across and 40% down the picture: off-centre on both axes, so a zoom about the wrong point
    // shows. Whole pixels, because a mouse event's coordinates are whole pixels.
    const px = Math.round(fit.rect.left + fit.rect.width * 0.3)
    const py = Math.round(fit.rect.top + fit.rect.height * 0.4)
    const fx = (px - fit.rect.left) / fit.rect.width
    const fy = (py - fit.rect.top) / fit.rect.height
    await page.mouse.click(px, py)
    const zoomed = await zoomOf(page)
    // One click lands on the picture's own pixels (1440 across), held to at least 2×.
    assert.equal(zoomed.scale, Math.min(Math.max(1440 / fit.rect.width, 2), 4))
    assert.ok(close(zoomed.rect.left + zoomed.rect.width * fx, px, 0.05) && close(zoomed.rect.top + zoomed.rect.height * fy, py, 0.05),
      `the pixel under the cursor moved: ${JSON.stringify({ px, py, zoomed })}`)
    assert.deepEqual(await page.$eval("[data-lightbox] img", (img) => [(img as HTMLElement).offsetWidth, (img as HTMLElement).offsetHeight]),
      [Math.round(fit.rect.width), Math.round(fit.rect.height)], "the zoom is a transform, not a re-layout")
    assert.equal(await page.$eval("[data-lightbox-stage]", (el) => getComputedStyle(el).cursor), "grab")

    // A drag moves the picture with the pointer, and the click that ends it neither zooms nor closes.
    await page.mouse.move(px, py)
    await page.mouse.down()
    await page.mouse.move(px - 30, py - 20, { steps: 3 })
    assert.equal(await page.$eval("[data-lightbox-stage]", (el) => getComputedStyle(el).cursor), "grabbing")
    await page.mouse.move(px - 60, py - 40, { steps: 3 })
    await page.mouse.up()
    const dragged = await zoomOf(page)
    assert.deepEqual([dragged.scale, px2(dragged.x - zoomed.x), px2(dragged.y - zoomed.y)], [zoomed.scale, -60, -40])
    assert.notEqual(await viewer(page), null)

    // A click without a drag goes back to fit.
    await page.mouse.click(px, py)
    const back = await zoomOf(page)
    assert.deepEqual([back.scale, back.x, back.y], [1, 0, 0])

    // A picture narrower than the stage when magnified leaves backdrop beside it: a click there first
    // returns the picture to fit, and only a click at fit closes the viewer.
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    await (await page.$("[data-fixture-message='1'] [data-lightbox-tile]"))!.click() // phone-375x812
    await pictureReady(page)
    const tall = await zoomOf(page)
    await page.mouse.click(tall.rect.left + tall.rect.width / 2, tall.rect.top + tall.rect.height / 2)
    const tallZoomed = await zoomOf(page)
    assert.equal(tallZoomed.scale, 2)
    const stage = (await (await page.$("[data-lightbox-stage]"))!.boundingBox())!
    await page.mouse.click(stage.x + 8, stage.y + stage.height / 2)
    assert.equal((await zoomOf(page)).scale, 1, "the backdrop click zoomed out")
    assert.notEqual(await viewer(page), null, "…and did not close the viewer")
    await page.mouse.click(stage.x + 8, stage.y + stage.height / 2)
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the zoom buttons, the + − 0 keys and a ctrl-wheel or trackpad pinch zoom; a plain wheel pans; paging starts at fit", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await (await page.$("[data-fixture-message='0'] [data-lightbox-tile]"))!.click()
    await pictureReady(page)
    const disabled = (label: string) => page.$eval(`[data-lightbox] button[aria-label="${label}"]`, (b) => b.getAttribute("aria-disabled") === "true")
    assert.deepEqual([await disabled("Zoom out"), await disabled("Zoom in")], [true, false], "nothing to zoom out of at fit")

    const scales: number[] = []
    for (const key of ["=", "=", "-", "0"] as const) {
      await page.keyboard.press(key)
      scales.push((await zoomOf(page)).scale)
    }
    assert.deepEqual(scales, [1.5, 2.25, 1.5, 1])
    assert.deepEqual(await pageKeys(page), [], "the zoom keys are the viewer's")

    // Four presses reach the limit: twice the picture's own pixels, and never less than 4×.
    const fitted = (await zoomOf(page)).rect.width
    const max = Math.min(Math.max((2 * 1440) / fitted, 4), 12)
    const steps: number[] = []
    for (let i = 0; i < 4; i++) {
      await page.click('[data-lightbox] button[aria-label="Zoom in"]')
      steps.push((await zoomOf(page)).scale)
    }
    assert.deepEqual(steps.map((s) => +s.toFixed(4)), [1.5, 2.25, 3.375, max].map((s) => +s.toFixed(4)))
    assert.deepEqual([await disabled("Zoom out"), await disabled("Zoom in")], [false, true])
    // A press at the limit does nothing, and the button keeps the focus: the keys still reach the viewer.
    await page.click('[data-lightbox] button[aria-label="Zoom in"]')
    assert.ok(sameScale((await zoomOf(page)).scale, max))
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Zoom in")
    await page.click('[data-lightbox] button[aria-label="Zoom out"]')
    assert.ok(sameScale((await zoomOf(page)).scale, max / 1.5))
    await page.keyboard.press("0")

    // ctrl + wheel — what a trackpad pinch sends — zooms about the cursor, by one bounded step a notch.
    // (Nearer the middle than the click above: 1.65× is short enough that a point 40% down would pull the
    // picture's top edge into the stage, and the clamp that stops it moves the picture by a fraction.)
    const fit = await zoomOf(page)
    const px = Math.round(fit.rect.left + fit.rect.width * 0.3)
    const py = Math.round(fit.rect.top + fit.rect.height * 0.45)
    const fx = (px - fit.rect.left) / fit.rect.width
    const fy = (py - fit.rect.top) / fit.rect.height
    await page.mouse.move(px, py)
    // A window listener sees each wheel AFTER the stage's own: whether the viewer prevented it is whether
    // the browser would have zoomed the whole page instead.
    await page.evaluate(() => {
      const w = window as Window & { __wheels?: boolean[] }
      w.__wheels = []
      window.addEventListener("wheel", (e) => w.__wheels!.push(e.defaultPrevented), { passive: true })
    })
    await page.keyboard.down("Control")
    await page.mouse.wheel({ deltaY: -100 })
    await page.keyboard.up("Control")
    const pinched = await zoomOf(page)
    assert.ok(sameScale(pinched.scale, Math.exp(0.5)), `scale ${pinched.scale}`)
    assert.ok(close(pinched.rect.left + pinched.rect.width * fx, px, 0.05) && close(pinched.rect.top + pinched.rect.height * fy, py, 0.05),
      `the pixel under the cursor moved: ${JSON.stringify({ px, py, pinched })}`)
    assert.deepEqual(await page.evaluate(() => (window as Window & { __wheels?: boolean[] }).__wheels), [true], "the page zoom was not prevented")

    // A plain wheel scrolls the magnified picture: content moves against the wheel, as a page does.
    await page.mouse.wheel({ deltaX: 50 })
    const panned = await zoomOf(page)
    assert.deepEqual([panned.scale, px2(panned.x - pinched.x), panned.y], [pinched.scale, -50, pinched.y])

    // Paging lands on the next picture at fit.
    await page.keyboard.press("ArrowRight")
    assert.equal((await viewer(page))?.caption, "After")
    const next = await zoomOf(page)
    assert.deepEqual([next.scale, next.x, next.y], [1, 0, 0])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on a phone, a pinch zooms the picture, one finger pans it, a double tap toggles it, and a swipe pages or closes", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch(PHONE)
  try {
    await (await page.$("[data-fixture-message='0'] [data-lightbox-tile]"))!.tap()
    await pictureReady(page)
    // A touch screen gets 44px header buttons and no zoom buttons — it pinches.
    const chrome = await page.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      buttons: [...document.querySelectorAll<HTMLElement>("[data-lightbox] header button")]
        .filter((b) => getComputedStyle(b).display !== "none")
        .map((b) => [b.getAttribute("aria-label"), b.getBoundingClientRect().width, b.getBoundingClientRect().height]),
    }))
    assert.deepEqual(chrome, { coarse: true, buttons: [["Download", 44, 44], ["Open in default viewer", 44, 44], ["Close", 44, 44]] })

    const fit = await zoomOf(page)
    const cx = fit.rect.left + fit.rect.width / 2
    const cy = fit.rect.top + fit.rect.height / 2
    // One tap on the picture is not a zoom: it waits to see whether a second follows.
    await page.touchscreen.tap(cx, cy)
    await new Promise((r) => setTimeout(r, 400))
    assert.equal((await zoomOf(page)).scale, 1)
    assert.notEqual(await viewer(page), null)

    // Two fingers spreading from 80px to 200px apart, their midpoint off the centre: 2.5×, with the pixel
    // under the midpoint held under it — along the axis the magnified picture is free to move in.
    const cdp = await page.createCDPSession()
    const touch = (type: string, points: [number, number][]) =>
      cdp.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: points.map(([x, y], id) => ({ x, y, id })) })
    const mx = cx + 30
    const my = cy - 20
    await touch("touchStart", [[mx - 40, my], [mx + 40, my]])
    for (let i = 1; i <= 6; i++) await touch("touchMove", [[mx - 40 - 10 * i, my], [mx + 40 + 10 * i, my]])
    await touch("touchEnd", [])
    const pinched = await zoomOf(page)
    assert.ok(sameScale(pinched.scale, 2.5), `scale ${pinched.scale}`)
    assert.ok(close(pinched.x, 30 - 30 * 2.5, 0.05), `x ${pinched.x}`)
    // 2.5× of a 16:10 shot is still shorter than the phone's stage, so it stays centred vertically.
    assert.equal(pinched.y, 0)
    assert.notEqual(await viewer(page), null, "the pinch's release did not close the viewer")

    // One finger moves the magnified picture.
    await touch("touchStart", [[cx, cy]])
    for (let i = 1; i <= 5; i++) await touch("touchMove", [[cx + 8 * i, cy + 6 * i]])
    await touch("touchEnd", [])
    const panned = await zoomOf(page)
    assert.deepEqual([panned.scale, px2(panned.x - pinched.x), panned.y], [pinched.scale, 40, 0])

    // A double tap returns to fit, and another zooms into the tapped point.
    await page.touchscreen.tap(cx, cy)
    await page.touchscreen.tap(cx, cy)
    const unzoomed = await zoomOf(page)
    assert.deepEqual([unzoomed.scale, unzoomed.x, unzoomed.y], [1, 0, 0])
    await page.touchscreen.tap(cx - 50, cy)
    await page.touchscreen.tap(cx - 50, cy)
    const tapped = await zoomOf(page)
    assert.ok(sameScale(tapped.scale, Math.min(Math.max(1440 / fit.rect.width, 2), 4)), `scale ${tapped.scale}`)
    assert.ok(close(tapped.x, 50 * tapped.scale - 50, 0.05), `x ${tapped.x}`)
    await page.touchscreen.tap(cx, cy)
    await page.touchscreen.tap(cx, cy)
    assert.equal((await zoomOf(page)).scale, 1)
    await new Promise((r) => setTimeout(r, 400))

    // At fit, a swipe sideways pages and a swipe down closes, the way a phone's photo viewer does.
    const swipe = async (dx: number, dy: number) => {
      await touch("touchStart", [[cx, cy]])
      for (let i = 1; i <= 8; i++) await touch("touchMove", [[cx + (dx * i) / 8, cy + (dy * i) / 8]])
      await touch("touchEnd", [])
    }
    await swipe(-160, 10)
    assert.equal((await viewer(page))?.counter, "2 / 2")
    assert.deepEqual([(await zoomOf(page)).x, (await zoomOf(page)).y], [0, 0], "the swipe's pull is released")
    await swipe(10, 200)
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))

    // And a tap on the backdrop at fit closes it too.
    await (await page.$("[data-fixture-message='0'] [data-lightbox-tile]"))!.tap()
    await page.waitForSelector("[data-lightbox] img")
    const stage = (await (await page.$("[data-lightbox-stage]"))!.boundingBox())!
    await page.touchscreen.tap(stage.x + stage.width / 2, stage.y + stage.height - 30)
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on a phone's answer sheet, a picture in an option opens the viewer without picking it, and the row still picks", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch(PHONE)
  try {
    await (await page.$("[data-fixture-open-sheet]"))!.tap()
    // The sheet slides up over 200ms and its gallery re-justifies once the pictures decode, so a tap aimed
    // before both settle lands where a tile WAS. At rest the sheet's bottom is the viewport's.
    await page.waitForFunction(() => {
      const sheet = document.querySelector("[data-answer-sheet]")
      const pictures = [...document.querySelectorAll<HTMLImageElement>("[data-answer-sheet] img")]
      return !!sheet && sheet.getAnimations().length === 0 && Math.abs(sheet.getBoundingClientRect().bottom - innerHeight) < 0.5
        && pictures.length === 3 && pictures.every((img) => img.complete && img.naturalWidth > 0)
    })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    // The sheet's option rows are buttons, and the gallery inside the first one is a portal: its tile's
    // tap reaches the row's handler too, which must leave it alone.
    await (await page.$("[data-answer-sheet] [data-lightbox-tile]"))!.tap()
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: "1 / 2", title: "sheet-desktop-1440x900.png", caption: "Desktop", picture: "/fixture/lightbox/sheet-desktop-1440x900.png" })
    // A pick here would also have moved the sheet on to its next step, taking the other option with it.
    assert.deepEqual(await page.evaluate(() => window.__sheetPicks), [], "looking at the gallery picked its option")
    await (await page.$("[data-lightbox] button[aria-label='Close']"))!.tap()
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    await (await page.$("[data-answer-sheet] [data-answer-option] img[data-local-path]"))!.tap()
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: null, title: "sheet-one-col-1440x900.png", caption: "One column", picture: "/fixture/lightbox/sheet-one-col-1440x900.png" })
    await (await page.$("[data-lightbox] button[aria-label='Close']"))!.tap()
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(await page.evaluate(() => window.__sheetPicks), [], "looking at a picture picked an option")
    assert.ok(await page.$("[data-answer-sheet]"), "closing the viewer left the sheet open")
    // The control: the row's label picks it.
    const label = (await page.$$("[data-answer-sheet] [data-answer-option]"))[1]
    const box = (await label.boundingBox())!
    await page.touchscreen.tap(box.x + box.width - 24, box.y + 14)
    await page.waitForFunction(() => window.__sheetPicks!.length === 1)
    assert.deepEqual(await page.evaluate(() => window.__sheetPicks), [1])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on a phone, Back closes the viewer and leaves the page where it was", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch(PHONE)
  try {
    const url = page.url()
    const depth = await page.evaluate(() => history.length)
    await (await page.$("[data-fixture-message='1'] [data-lightbox-tile]"))!.tap()
    await page.waitForSelector("[data-lightbox]")
    // The viewer holds a history entry of its own, so Back pops that rather than the page's.
    assert.equal(await page.evaluate(() => history.length), depth + 1)
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.equal(page.url(), url, "Back closed the viewer, not the page")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a fence is a gallery on a done card and in a question option, and any picture opens the viewer with its message's pictures", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    // No fence is left standing as a code block anywhere: each became its gallery.
    assert.equal(await page.$$eval("code.language-lightbox", (els) => els.length), 0)

    // The done card's gallery is the transcript's, inside the card's own prose.
    const card = await page.$$("[data-fixture-card] .md-body .md-lightbox [data-lightbox-tile]")
    assert.equal(card.length, 2)
    await card[1].click()
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: "2 / 2", title: "card-after-1440x900.png", caption: "After", picture: "/fixture/lightbox/card-after-1440x900.png" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))

    // In a question option the pictures are there to be looked at before choosing: a tile, or a single
    // picture, opens the viewer and does NOT pick the option.
    const option = await page.$$("[data-fixture-question] [data-question-option]")
    await (await option[0].$("[data-lightbox-tile]"))!.click()
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: "1 / 2", title: "two-col-1440x900.png", caption: "Desktop", picture: "/fixture/lightbox/two-col-1440x900.png" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    await (await option[1].$("img[data-local-path]"))!.click()
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: null, title: "one-col-1440x900.png", caption: "One column", picture: "/fixture/lightbox/one-col-1440x900.png" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(await page.evaluate(() => window.__chips), [], "looking at a picture picked an option")
    // The control: the option's own label still picks it.
    const label = (await (await option[1].$("[id]"))!.boundingBox())!
    await page.mouse.click(label.x + 4, label.y + label.height / 2)
    assert.deepEqual(await page.evaluate(() => window.__chips), [1])

    // A message's loose pictures — a Markdown image and a bare path line — page together, in order, each
    // named by its alt text when it has one and by its file otherwise.
    await page.click("[data-fixture-loose] .md-body img[data-local-path]")
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: "1 / 2", title: "settings-1200x800.png", caption: "The settings page", picture: "/fixture/lightbox/settings-1200x800.png" })
    await page.keyboard.press("ArrowRight")
    assert.deepEqual(await viewer(page), { counter: "2 / 2", title: "terminal-1000x700.png", caption: null, picture: "/fixture/lightbox/terminal-1000x700.png" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    await page.click("[data-fixture-loose] figure img[data-local-path]")
    await page.waitForSelector("[data-lightbox]")
    assert.equal((await viewer(page))?.counter, "2 / 2")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    // A LINK to a picture names that one picture.
    await page.click("[data-fixture-loose] a[data-local-image]")
    await page.waitForSelector("[data-lightbox]")
    assert.deepEqual(await viewer(page), { counter: null, title: "log-800x600.png", caption: "the log view", picture: "/fixture/lightbox/log-800x600.png" })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// A video in a fence (maintainer 2026-10-03: the lightbox is the way to show "images … and other forms of
// multimedia, I suppose, like videos"): a tile of its first frame with a play mark, at the video's own
// shape, that plays in the viewer — and does not zoom, because a player is not a picture.
test("a video is a tile of its first frame with a play mark, and plays in the viewer without zooming", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const tile = await page.$eval("[data-fixture-message='3'] [data-lightbox-video]", (button) => {
      const box = button.querySelector("span")!.getBoundingClientRect()
      const mark = button.querySelector("[data-lightbox-play]")!.getBoundingClientRect()
      const video = button.querySelector("video")!
      return {
        label: button.getAttribute("aria-label"),
        ratio: box.width / box.height,
        natural: video.videoWidth / video.videoHeight,
        // The play mark sits on the tile's centre.
        dx: mark.left + mark.width / 2 - (box.left + box.width / 2),
        dy: mark.top + mark.height / 2 - (box.top + box.height / 2),
        playing: !video.paused,
        controls: video.controls,
      }
    })
    assert.equal(tile.label, "Play The whole flow")
    assert.ok(close(tile.natural, 16 / 9, 0.01), `natural ${tile.natural}`)
    assert.ok(close(tile.ratio, tile.natural, 0.02), `the tile takes the video's shape: ${tile.ratio}`)
    assert.ok(close(tile.dx, 0) && close(tile.dy, 0), `the play mark is off centre: ${tile.dx}, ${tile.dy}`)
    assert.deepEqual([tile.playing, tile.controls], [false, false], "a tile is a still, never a player")

    await (await page.$("[data-fixture-message='3'] [data-lightbox-video]"))!.click()
    await page.waitForSelector("[data-lightbox] video")
    const opened = await page.evaluate(() => {
      const v = document.querySelector("[data-lightbox]")!
      return {
        counter: v.querySelector("[data-lightbox-counter]")?.textContent,
        title: v.querySelector("h2")?.textContent,
        caption: v.querySelector("[data-lightbox-caption]")?.textContent,
        controls: v.querySelector("video")!.controls,
        buttons: [...v.querySelectorAll<HTMLElement>("header button")].map((b) => b.getAttribute("aria-label")),
      }
    })
    assert.deepEqual(opened, { counter: "2 / 2", title: "flow-320x180.webm", caption: "The whole flow", controls: true, buttons: ["Download", "Open in default player", "Close"] })
    // It plays as it opens: the click that opened it asked for it.
    await page.waitForFunction(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-lightbox] video")
      return !!v && !v.paused && v.currentTime > 0
    }, { timeout: 5000 })

    // Space pauses and resumes it from anywhere in the viewer, and reaches nothing behind it.
    await page.keyboard.press(" ")
    assert.equal(await page.$eval("[data-lightbox] video", (v) => (v as HTMLVideoElement).paused), true)
    await page.keyboard.press(" ")
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>("[data-lightbox] video")!.paused)
    // The zoom keys and a ctrl-wheel do nothing to a video.
    await page.keyboard.press("+")
    const box = (await (await page.$("[data-lightbox] video"))!.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.down("Control")
    await page.mouse.wheel({ deltaY: -200 })
    await page.keyboard.up("Control")
    assert.equal(await page.$eval("[data-lightbox] video", (v) => (v as HTMLElement).style.transform), "translate(0px, 0px)")
    // A click on the video is the player's, never the backdrop's: the viewer stays open.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await new Promise((r) => setTimeout(r, 300))
    assert.notEqual(await viewer(page), null, "a click on the video closed the viewer")
    // The bare Control held for the ctrl-wheel is no key of the viewer's, so it alone reaches the page.
    assert.deepEqual(await pageKeys(page), ["Control"], "a key the viewer handled must not reach the page")

    // Paging from the video lands on the picture beside it, which zooms again.
    await page.keyboard.press("ArrowLeft")
    await page.waitForSelector("[data-lightbox] img")
    assert.equal((await viewer(page))?.counter, "1 / 2")
    assert.equal(await page.$("[data-lightbox] video"), null, "the video unmounted, and stopped, as it paged away")
    assert.deepEqual(
      await page.$$eval("[data-lightbox] header button", (bs) => bs.map((b) => b.getAttribute("aria-label"))),
      ["Zoom out", "Zoom in", "Download", "Open in default viewer", "Close"],
    )
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-lightbox]"))
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("on a phone, a swipe that starts on a video is the player's, and one from the backdrop around it pages", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors } = await launch(PHONE)
  try {
    await (await page.$("[data-fixture-message='3'] [data-lightbox-video]"))!.tap()
    await page.waitForSelector("[data-lightbox] video")
    await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>("[data-lightbox] video")?.videoWidth ?? 0) > 0)
    const cdp = await page.createCDPSession()
    const touch = (type: string, points: [number, number][]) =>
      cdp.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: points.map(([x, y], id) => ({ x, y, id })) })
    const swipe = async (x: number, y: number, dx: number) => {
      await touch("touchStart", [[x, y]])
      for (let i = 1; i <= 8; i++) await touch("touchMove", [[x + (dx * i) / 8, y]])
      await touch("touchEnd", [])
    }
    const video = (await (await page.$("[data-lightbox] video"))!.boundingBox())!
    const stage = (await (await page.$("[data-lightbox-stage]"))!.boundingBox())!
    // A 16:9 video on a portrait phone leaves backdrop above and below it.
    assert.ok(video.y - stage.y > 60, `no backdrop above the video: ${JSON.stringify({ video, stage })}`)

    await swipe(video.x + video.width / 2, video.y + video.height / 2, 160)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal((await viewer(page))?.counter, "2 / 2", "a swipe across the video paged away from it")

    await swipe(stage.x + stage.width / 2, stage.y + (video.y - stage.y) / 2, 160)
    await page.waitForSelector("[data-lightbox] img")
    assert.equal((await viewer(page))?.counter, "1 / 2")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
