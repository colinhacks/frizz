import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_FAVICON_BADGE_E2E_URL to its origin, e.g.
//   FRIZZ_FAVICON_BADGE_E2E_URL=http://localhost:5731 nub run test packages/web/src/lib/faviconBadge.e2e.test.ts
const baseUrl = process.env.FRIZZ_FAVICON_BADGE_E2E_URL

// Everything this module does is a browser seam — an <img> decode of the SVG, a canvas composite, a
// data URL, and a mutation of the document's own <link> elements — so there is nothing to assert
// outside one. What NO test can reach is the tab strip itself: neither headless Chrome nor CDP exposes
// the favicon a tab is showing. This pins the document state Chrome reads it from, and the pixels.
const ORIGINAL = [
  { href: "/favicon.svg?v=6", type: "image/svg+xml", sizes: null },
  { href: "/favicon-32.png?v=6", type: "image/png", sizes: "32x32" },
  { href: "/favicon-16.png?v=6", type: "image/png", sizes: "16x16" },
]

const readLinks = () => [...document.querySelectorAll('link[rel~="icon"]')].map((link) => ({
  href: link.getAttribute("href"),
  type: link.getAttribute("type"),
  sizes: link.getAttribute("sizes"),
}))

test("the rest dot repoints every icon link at a badged raster, and clearing it restores them", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.goto(`${baseUrl}/favicon-badge-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForFunction(() => window.specimenReady === true)
    assert.deepEqual(await page.evaluate(readLinks), ORIGINAL)

    // THE RACE FIRST, while the raster is still uncached and the window is real: a thread that rests and
    // is steered again before the icon has decoded must not have the late badge land on a working tab.
    await page.evaluate(() => { window.setFaviconBadge(true); window.setFaviconBadge(false) })
    await new Promise((r) => setTimeout(r, 500))
    assert.deepEqual(await page.evaluate(readLinks), ORIGINAL)

    await page.evaluate(() => window.setFaviconBadge(true))
    await page.waitForFunction(() => document.querySelector('link[rel~="icon"]')!.getAttribute("href")!.startsWith("data:image/png"))
    const badged = await page.evaluate(readLinks)
    // ALL of them: a browser picks among several rel="icon" candidates by its own rules, so one left
    // pointing at the plain PNG is one it may show instead.
    assert.equal(new Set(badged.map((l) => l.href)).size, 1)
    for (const link of badged) assert.deepEqual({ type: link.type, sizes: link.sizes }, { type: "image/png", sizes: null })
    // The home-screen art is a different `rel` token and is not the tab's.
    assert.equal(await page.$eval('link[rel="apple-touch-icon"]', (l) => l.getAttribute("href")), "/apple-touch-icon.png?v=6")

    const pixels = await page.evaluate(async (url) => {
      const img = new Image()
      img.src = url
      await img.decode()
      const canvas = document.createElement("canvas")
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext("2d")!
      ctx.drawImage(img, 0, 0)
      const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]
      return { size: [img.naturalWidth, img.naturalHeight], dot: at(48, 16), ring: at(48, 30), tile: at(32, 56), oldCorner: at(48, 48) }
    }, badged[0]!.href!)
    assert.deepEqual(pixels.size, [64, 64])
    assert.deepEqual(pixels.dot, [0x4a, 0x9e, 0xff, 255])
    // The ring is PUNCHED OUT, not painted: the strip behind a favicon is the browser theme's colour.
    assert.equal(pixels.ring[3], 0)
    assert.equal(pixels.tile[3], 255)
    // TOP right, not bottom: the corner it first shipped in is plain tile again.
    assert.equal(pixels.oldCorner[3], 255)
    assert.notDeepEqual(pixels.oldCorner, pixels.dot)

    await page.evaluate(() => window.setFaviconBadge(false))
    assert.deepEqual(await page.evaluate(readLinks), ORIGINAL)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
