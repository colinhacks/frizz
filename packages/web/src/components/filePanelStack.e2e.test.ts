import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Real server, real transcript, real file reads; only the absent launcher status probe is stubbed.
// Boot scripts/adhoc-stack.mjs, then scripts/seed-file-panel-stack.mjs --home=<its HOME>.
// FRIZZ_FILE_STACK_E2E_URL=http://127.0.0.1:<port> nub --test <this file>
const baseUrl = process.env.FRIZZ_FILE_STACK_E2E_URL
const shots = process.env.FRIZZ_FILE_STACK_SHOTS

// A QUEUED THREAD OPENS FROM THE HUMAN'S LAST MESSAGE, in the pane full screen as beside the sidebar (ChatView
// `queueWindow`), which is what a desktop's thread path draws since 2026-11-11: the seeded file links sit in
// the message before it, one click away.
async function revealEarlier(page: import("puppeteer").Page, link: string): Promise<void> {
  await page.waitForFunction((link) => !!document.querySelector(link) || !!document.querySelector("[data-standalone-thread] [data-load-earlier]"), { timeout: 30_000 }, link)
  if (!(await page.$(link))) await page.click("[data-standalone-thread] [data-load-earlier]")
  await page.waitForSelector(link)
}

test("full-screen file links push readers and Escape restores the reader underneath", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    const slot = "[data-file-viewer-slot]"
    const top = `${slot}:last-child`
    const waitCount = async (count: number) => {
      await page.waitForFunction((count) => document.querySelectorAll("[data-file-viewer-slot]").length === count, {}, count)
      await page.waitForFunction(() => [...document.querySelectorAll("[data-file-viewer-slot]")].every((el) => el.getAnimations().length === 0 && getComputedStyle(el).translate === "0px"))
    }
    // The prose font is no longer a setting (index.html pins `data-font="sans"`, 2026-09-19), so the
    // run varies only the width.
    for (const width of [1440, 1200]) {
      await page.setViewport({ width, height: 900 })
      await page.goto(`${baseUrl}/thread/file-panel-stack`, { waitUntil: "networkidle2" })
      const firstLink = '[data-standalone-thread] [data-local-path$="/first.md"]'
      await revealEarlier(page, firstLink)
      await page.click(firstLink)
      await waitCount(1)
      await page.waitForSelector(`${top} .md-body [data-local-path]`)
      const original = await page.$(slot)
      const threadWidth = await page.$eval("[data-standalone-thread]", (el) => el.getBoundingClientRect().width)
      // Mark the original DOM node and scroll to its final link. Returning must preserve both.
      const scroll = await page.$eval(`${top} .overflow-y-auto`, (el) => { el.scrollTop = el.scrollHeight; return el.scrollTop })
      assert.ok(scroll > 0)
      await original!.evaluate((el) => { (el as HTMLElement).dataset.originalReader = "true" })
      await page.evaluate(() => {
        (window as any).fileSlides = []
        document.addEventListener("transitionrun", (event) => {
          if ((event.target as Element).matches("[data-file-viewer-slot]") && event.propertyName === "translate") {
            (window as any).fileSlides.push(event.target)
          }
        })
      })
      await page.click(`${top} .md-body p:last-child [data-local-path]`)
      await waitCount(2)
      assert.equal(await page.evaluate(() => (window as any).fileSlides.length), 1, "the nested reader actually slides, not just swaps content")
      await page.waitForSelector(`${top} [data-local-path$="/first.md"]`)
      assert.equal(await page.$eval(slot, (el) => (el as HTMLElement).inert), true)
      assert.equal(await page.$eval("[data-standalone-thread]", (el) => el.getBoundingClientRect().width), threadWidth)
      await page.click(`${top} [data-local-path$="/first.md"]`)
      await waitCount(3)
      assert.equal(await page.$eval(`${top} .overflow-y-auto`, (el) => el.scrollTop), 0, "revisits start a fresh reader")
      await page.keyboard.press("Escape")
      await waitCount(2)
      await page.click(`${top} [data-local-path$="/example.ts"]`)
      await waitCount(3)
      await page.waitForFunction(() => document.querySelector('[data-file-viewer-slot]:last-child pre')?.textContent?.includes("stacked"))
      await page.click(`${top} button[aria-label="Close"]`)
      await waitCount(2)
      // A mounted reader below must not intercept or duplicate the top reader's selection shortcut.
      await page.$eval(`${top} .md-body p:last-child`, (el) => {
        const range = document.createRange(); range.selectNodeContents(el)
        window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
      })
      await page.keyboard.down("Control"); await page.keyboard.press("i"); await page.keyboard.up("Control")
      assert.equal(await page.evaluate(async () => {
        const path = "/src/store.ts"; const { store } = await import(path)
        return store.composerContext["file-panel-stack"]?.length
      }), 1)
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      // Source mode stays alive while another visit covers it.
      await page.click(`${top} [aria-label="File view"] button:last-child`)
      await page.click(firstLink)
      await waitCount(3)
      await page.keyboard.press("Escape")
      await waitCount(2)
      assert.equal(await page.$eval(`${top} [aria-label="File view"] button:last-child`, (el) => el.getAttribute("aria-pressed")), "true")
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: `${shots}/file-stack-${width}.png` })
      }
      await page.keyboard.press("Escape")
      await waitCount(1)
      assert.equal(await original!.evaluate((el) => el.isConnected && (el as HTMLElement).dataset.originalReader === "true"), true)
      assert.equal(await page.$eval(`${top} .overflow-y-auto`, (el) => el.scrollTop), scroll)
      assert.equal(await page.$eval(top, (el) => (el as HTMLElement).inert), false)
      // Shrinking below the split uses the existing Markdown drawers without destroying the hidden split
      // stack. Not to a phone's width: there a desktop's thread path is the phone's page, another surface
      // (routes.tsx BoardRoute), as the board beside the sidebar always was.
      await page.setViewport({ width: 1000, height: 844 })
      await page.click(firstLink)
      await page.waitForSelector(".frizz-sheet-panel .md-body [data-local-path]")
      await page.waitForFunction(() => [...document.querySelectorAll(".frizz-sheet-panel")].every((el) => el.classList.contains("translate-x-0") && el.getAnimations().length === 0))
      await page.click('.frizz-sheet-panel [data-local-path$="/second.md"]')
      await page.waitForFunction(() => document.querySelectorAll(".frizz-sheet-panel").length === 2)
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => document.querySelectorAll(".frizz-sheet-panel").length === 1)
      if (shots) await page.screenshot({ path: `${shots}/file-stack-narrow-${width}.png` })
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => !document.querySelector(".frizz-sheet-panel"))
      assert.equal(await page.$$eval(slot, (els) => els.length), 1, "drawers unwind before split readers")
      await page.setViewport({ width, height: 900 })
      await page.keyboard.press("Escape")
      await waitCount(0)
      // The rail stands by itself only where the sidebar could stand beside it too (lib/threadPane.ts
      // paneRailWanted, 1360px); narrower, the last file closing leaves the thread on its own.
      if (width >= 1360) assert.equal(await page.$eval("[data-side-pane] > div", (el) => el.inert), false)
      else assert.equal(await page.$("[data-side-pane]"), null)
    }
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }])
    await page.click('[data-standalone-thread] [data-local-path$="/first.md"]')
    await waitCount(1)
    await page.click(`${top} [data-local-path$="/second.md"]`)
    await waitCount(2)
    assert.equal(await page.$eval(top, (el) => getComputedStyle(el).transitionProperty), "none")
    await page.keyboard.press("Escape")
    await waitCount(1)
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    assert.equal(await page.evaluate(async () => {
      const path = "/src/store.ts"; const { store } = await import(path)
      return store.filePanels.length
    }), 0, "leaving full screen clears the file stack")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// THE ROUTING RULE, against the real server's gates (maintainer 2026-10-13, after a PDF opened this
// page's viewer onto "Couldn't read this file … not a text file"): a click opens what Frizz can show IN
// Frizz, and hands everything else to the system — never a reader that cannot show it. The opener is
// set to "copy" first, so a fall-through answers with the path instead of launching an app on this Mac.
test("full-screen file links open what Frizz can show and hand the rest to the system", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    const opened: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      const url = new URL(r.url())
      if (url.pathname.endsWith("/openLocalFile")) opened.push(String(JSON.parse(r.postData() ?? "{}").path))
      if (url.pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    // The headless shell has no PDF viewer and says so (`pdfViewerEnabled` false), so it stands in for a
    // desktop Chrome — which has one — by saying the opposite, until the no-viewer case below.
    const pdfViewer = (enabled: boolean) => { Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", { configurable: true, get: () => enabled }) }
    await page.evaluateOnNewDocument(pdfViewer, true)
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`${baseUrl}/thread/file-panel-stack`, { waitUntil: "networkidle2" })
    await page.evaluate(async () => {
      const path = "/src/api/rpc.ts"; const { rpc } = await import(path)
      await rpc.settingsSet({ ...(await rpc.settingsGet()), localFileOpener: "copy" })
    })
    const link = (name: string) => `[data-standalone-thread] [data-local-path$="/${name}"]`
    const state = () => page.evaluate(async () => {
      const path = "/src/store.ts"; const { store } = await import(path)
      return { panels: store.filePanels.length as number, lightbox: store.lightbox?.images.map((i: { path: string }) => i.path) ?? null, toast: store.toast?.text ?? null }
    })
    await page.waitForSelector(link("report.pdf"))

    // A PDF opens IN the panel, in the browser's own viewer, fed by the gated route as a real PDF. The
    // FRAME's own navigation is the request that matters: it carries no Origin, so it passes the
    // server's origin gate only as a same-origin fetch, and Chrome's viewer renders what it answers.
    const framed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("local-file") && r.url().includes("report.pdf") && r.request().resourceType() === "document")
    await page.click(link("report.pdf"))
    const navigation = await framed
    assert.equal(navigation.frame() === page.mainFrame(), false, "the frame navigated, not the page")
    assert.deepEqual([navigation.status(), navigation.headers()["content-type"], navigation.headers()["content-disposition"]], [200, "application/pdf", "inline; filename*=UTF-8''report.pdf"])
    const frame = await page.waitForSelector("[data-file-viewer-slot] iframe[data-pdf-view]")
    const src = await frame!.evaluate((el) => (el as HTMLIFrameElement).src)
    const response = await page.evaluate(async (src) => {
      const res = await fetch(src)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { status: res.status, type: res.headers.get("content-type"), head: new TextDecoder().decode(bytes.subarray(0, 8)), size: bytes.length }
    }, src)
    const { size: pdfSize, ...pdf } = response
    assert.deepEqual(pdf, { status: 200, type: "application/pdf", head: "%PDF-1.4" })
    assert.equal(await page.$eval("[data-file-viewer-slot]", (el) => el.textContent?.includes("⌘I")), false, "no selection hint over a frame the page cannot select in")
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await page.waitForFunction(() => [...document.querySelectorAll("[data-file-viewer-slot]")].every((el) => el.getAnimations().length === 0 && getComputedStyle(el).translate === "0px"))
      await page.screenshot({ path: `${shots}/file-kinds-pdf.png` })
    }
    await page.click('[data-file-viewer-slot] button[aria-label="Close"]')
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 0)

    // A binary file opens NO reader: the server's read calls it binary, and it falls through to the
    // opener — here "copy", which answers with the path rather than launching anything.
    await page.click(link("bundle.zip"))
    await page.waitForFunction(async () => {
      const path = "/src/store.ts"; const { store } = await import(path)
      return store.toast?.text === "Copied local path"
    })
    assert.equal((await state()).panels, 0)
    assert.equal(opened.length, 1)
    assert.match(opened[0]!, /\/bundle\.zip$/)

    // A picture opens in the lightbox, not in a text viewer.
    await page.click(link("shot.png"))
    await page.waitForFunction(async () => {
      const path = "/src/store.ts"; const { store } = await import(path)
      return store.lightbox !== null
    })
    const lit = await state()
    assert.equal(lit.panels, 0)
    assert.match(lit.lightbox?.[0] ?? "", /\/shot\.png$/)
    await page.keyboard.press("Escape")
    await page.waitForFunction(async () => {
      const path = "/src/store.ts"; const { store } = await import(path)
      return store.lightbox === null
    })

    // And text still opens as source.
    await page.click(link("notes.txt"))
    await page.waitForFunction(() => document.querySelector("[data-file-viewer-slot] pre")?.textContent?.includes("plain notes"))
    await page.click('[data-file-viewer-slot] button[aria-label="Close"]')
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 0)
    assert.equal(opened.length, 1, "neither the picture nor the text reached the opener")

    // An HTML page is text too, but the browser is its viewer: on this wide window, where text opens
    // beside the thread as source, a linked page still goes to the opener (maintainer 2026-11-02).
    await page.click(link("options.html"))
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 0)
    const toBrowser = Date.now() + 10_000
    while (opened.length < 2 && Date.now() < toBrowser) await new Promise((r) => setTimeout(r, 50))
    assert.match(opened[1] ?? "", /\/options\.html$/)
    assert.equal((await state()).panels, 0, "and no source panel opened for it")

    // A browser that would DOWNLOAD a PDF (Chrome's "Download PDF files", or this shell as it really
    // is) has no viewer to lend the panel, so a PDF falls through to the opener like the zip did.
    await page.evaluate(pdfViewer, false)
    const toOpener = page.waitForRequest((r) => r.url().endsWith("/openLocalFile") && (r.postData() ?? "").includes("report.pdf"), { timeout: 10_000 })
    await page.click(link("report.pdf"))
    await toOpener
    assert.match(opened[2] ?? "", /\/report\.pdf$/)
    assert.equal((await state()).panels, 0, "and opens no blank panel")
    await page.evaluate(pdfViewer, true)

    // ON A PHONE the desktop opener is the wrong machine: a PDF opens in the phone's own viewer (a new
    // tab on the route), and a binary file downloads from it. The headless shell has no PDF viewer, so
    // its new tab DOWNLOADS the PDF — what Android's Chrome does too — and both arrive as downloads here,
    // which is the observation that the browser itself fetched each one off the gated route.
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForSelector(link("report.pdf"))
    const downloads = mkdtempSync(join(tmpdir(), "frizz-file-kinds-downloads-"))
    const finished: { name: string; bytes: number }[] = []
    const names = new Map<string, string>()
    // Browser-level, not the page's: the PDF downloads in the NEW tab, whose events the page never sees.
    const cdp = await browser.target().createCDPSession()
    cdp.on("Browser.downloadWillBegin", (e) => { names.set(e.guid, e.suggestedFilename) })
    cdp.on("Browser.downloadProgress", (e) => { if (e.state === "completed") finished.push({ name: names.get(e.guid) ?? "?", bytes: e.receivedBytes }) })
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true })
    try {
      await page.click(link("report.pdf"))
      await page.click(link("bundle.zip"))
      const deadline = Date.now() + 10_000
      while (finished.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      assert.deepEqual(finished.sort((a, b) => a.name.localeCompare(b.name)), [
        { name: "bundle.zip", bytes: 22 },
        { name: "report.pdf", bytes: pdfSize },
      ])
    } finally {
      rmSync(downloads, { recursive: true, force: true })
    }
    assert.equal(opened.length, 3, "nothing on the phone reached the desktop opener")
    assert.equal(await page.$$eval(".frizz-sheet-panel", (els) => els.length), 0, "and no reader opened for either")
    // An HTML page on a phone opens as source in the reader: the desktop opener is the wrong machine,
    // and the server serves a page only as a sandboxed download, never as a document to render.
    await page.click(link("options.html"))
    await page.waitForFunction(() => document.querySelector(".frizz-sheet-panel")?.textContent?.includes("page source, shown only on a phone"))
    assert.equal(opened.length, 3, "and the page did not reach the desktop opener either")

    await page.evaluate(async () => {
      const path = "/src/api/rpc.ts"; const { rpc } = await import(path)
      const { localFileOpener: _, ...rest } = await rpc.settingsGet()
      await rpc.settingsSet(rest)
    })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
