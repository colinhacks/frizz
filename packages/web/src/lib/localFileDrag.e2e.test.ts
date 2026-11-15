import assert from "node:assert/strict"
import test from "node:test"

// Every file handle the board draws drags out as its file (lib/localFileDrag.ts): a real mouse press
// and move on each one in packages/web/local-file-drag-fixture.html, then what the page put on the
// drag. Driven by the mouse rather than by a dispatched event, because the half that breaks quietly
// is whether the element DRAGS at all: a button or a `<code>` needs `draggable`, and a row whose
// mousedown handler cancels the default never starts one.
//
// What this cannot reach is the hop out of Chrome — the file promise Finder, Mail or Notes accept.
// A headless browser has no desktop to drop on; that hop is Chrome's own `DownloadURL` handling.
//
//   FRIZZ_LOCAL_FILE_DRAG_E2E_URL=http://127.0.0.1:<vite port> nub run test packages/web/src/lib/localFileDrag.e2e.test.ts
const baseUrl = process.env.FRIZZ_LOCAL_FILE_DRAG_E2E_URL

// A real 1x1 PNG: the missing-image handler swaps an undecodable picture for its path text.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

type Recorded = { started: string | null; cancelled: boolean; writes: string[][] }

test("every local file handle drags out as its path and its file", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.setViewport({ width: 900, height: 1400 })
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (request.url().includes("/_frizz/local-image?path=%2Ffixture%2Fshot.png")) void request.respond({ status: 200, contentType: "image/png", body: PIXEL_PNG })
      else void request.continue()
    })
    // Every write the page makes to a drag, whichever listener makes it: a React row stops the event's
    // propagation once it has written, so nothing listening after it would see the data.
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { __drag: Recorded }
      w.__drag = { started: null, cancelled: false, writes: [] }
      const setData = DataTransfer.prototype.setData
      const clearData = DataTransfer.prototype.clearData
      DataTransfer.prototype.setData = function (type: string, value: string) {
        w.__drag.writes.push([type, value])
        return setData.call(this, type, value)
      }
      DataTransfer.prototype.clearData = function (...args: [string?]) {
        w.__drag.writes.push(["clear"])
        return clearData.apply(this, args)
      }
      let last: DragEvent | null = null
      window.addEventListener("dragstart", (event) => {
        last = event
        w.__drag.started = event.target instanceof Element ? event.target.tagName : String(event.target)
      }, true)
      // Read once the event has run every listener: a handler that cancelled it cancelled the drag.
      Object.defineProperty(w.__drag, "cancelled", { get: () => !!last?.defaultPrevented })
    })
    await page.goto(`${baseUrl}/local-file-drag-fixture.html`, { waitUntil: "networkidle0" })
    // Last to appear: the inline-code path waits on the resolver's round trip.
    await page.waitForSelector('code[data-local-path="/fixture/src/app.ts"]', { timeout: 20_000 })
    await page.waitForSelector('[data-case="block-image"] img')

    const origin = new URL(baseUrl!).origin
    const fileUrl = (path: string) => `${origin}/_frizz/local-file?path=${encodeURIComponent(path)}`
    const imageUrl = (path: string) => `${origin}/_frizz/local-image?path=${encodeURIComponent(path)}`
    const cases: { name: string; selector: string; path: string; downloadUrl: string }[] = [
      { name: "a Markdown file link", selector: '.md-body button[data-local-path="/fixture/report.md"]', path: "/fixture/report.md", downloadUrl: `text/markdown:report.md:${fileUrl("/fixture/report.md")}` },
      { name: "a Markdown link to a picture", selector: '.md-body a[data-local-path="/fixture/shot.png"]', path: "/fixture/shot.png", downloadUrl: `image/png:shot.png:${imageUrl("/fixture/shot.png")}` },
      { name: "a Markdown picture", selector: '.md-body img[data-local-path="/fixture/shot.png"]', path: "/fixture/shot.png", downloadUrl: `image/png:shot.png:${imageUrl("/fixture/shot.png")}` },
      { name: "an inline-code path", selector: 'code[data-local-path="/fixture/src/app.ts"]', path: "/fixture/src/app.ts", downloadUrl: `application/octet-stream:app.ts:${fileUrl("/fixture/src/app.ts")}` },
      { name: "an attachment chip", selector: '[data-case="block-file"] button', path: "/fixture/notes.txt", downloadUrl: `text/plain:notes.txt:${fileUrl("/fixture/notes.txt")}` },
      { name: "an attached picture", selector: '[data-case="block-image"] img', path: "/fixture/shot.png", downloadUrl: `image/png:shot.png:${imageUrl("/fixture/shot.png")}` },
      { name: "a tool header's path", selector: '[data-case="path-link"] button[title="/fixture/src/server.ts"]', path: "/fixture/src/server.ts", downloadUrl: `application/octet-stream:server.ts:${fileUrl("/fixture/src/server.ts")}` },
      { name: "a saved file link", selector: '[data-case="thread-links"] button[data-thread-link]', path: "/fixture/audit.pdf", downloadUrl: `application/pdf:audit.pdf:${fileUrl("/fixture/audit.pdf")}` },
      { name: "a saved file link in the panel", selector: '[data-case="thread-links-panel"] button[data-thread-link]', path: "/fixture/audit.pdf", downloadUrl: `application/pdf:audit.pdf:${fileUrl("/fixture/audit.pdf")}` },
      { name: "a rail file row", selector: '[data-case="wait-row"] button', path: "/fixture/src/rail.ts", downloadUrl: `application/octet-stream:rail.ts:${fileUrl("/fixture/src/rail.ts")}` },
    ]

    const results: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}
    for (const c of cases) {
      const box = await page.$eval(c.selector, (el) => {
        el.scrollIntoView({ block: "center" })
        const r = el.getBoundingClientRect()
        return { x: r.x + Math.min(r.width / 2, 20), y: r.y + r.height / 2 }
      })
      await page.evaluate(() => {
        const w = window as unknown as { __drag: Recorded }
        w.__drag.started = null
        w.__drag.writes = []
      })
      await page.mouse.move(box.x, box.y)
      await page.mouse.down()
      await page.mouse.move(box.x + 30, box.y + 30, { steps: 6 })
      await page.mouse.up()
      await page.keyboard.press("Escape")
      results[c.name] = await page.evaluate(() => {
        const d = (window as unknown as { __drag: Recorded }).__drag
        return { started: d.started !== null, cancelled: d.cancelled, writes: d.writes }
      })
      expected[c.name] = { started: true, cancelled: false, writes: [["clear"], ["text/plain", c.path], ["DownloadURL", c.downloadUrl]] }
    }
    assert.deepEqual(results, expected)

    // The control: prose that names no file starts no file drag. A drag that starts on plain text
    // selects it, as it always did.
    const plain = await page.evaluateHandle(() => [...document.querySelectorAll(".md-body p")].find((p) => p.textContent?.startsWith("Read the")) ?? null)
    const start = await page.evaluate((p) => {
      const range = document.createRange()
      range.setStart((p as HTMLElement).firstChild!, 0)
      const r = range.getBoundingClientRect()
      return { x: r.x + 2, y: r.y + r.height / 2 }
    }, plain)
    await page.evaluate(() => { (window as unknown as { __drag: Recorded }).__drag.writes = [] })
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 30, start.y, { steps: 6 })
    await page.mouse.up()
    const control = await page.evaluate(() => ({
      writes: (window as unknown as { __drag: Recorded }).__drag.writes,
      selected: String(window.getSelection()).length > 0,
    }))
    assert.deepEqual(control, { writes: [], selected: true })

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
