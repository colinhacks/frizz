import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_LOCAL_FILE_MARKDOWN_E2E_URL

// A REAL 1x1 PNG. This used to be the 8-byte PNG signature alone, which is not a decodable image —
// Chrome fired `error` on it, lib/local-file-links.ts's missing-image handler (correctly) swapped the
// dead <img> for the plain path, and every assertion below read `undefined` off an element that was no
// longer there. The test had gone red on main before anyone noticed, because what it asserts is the
// markup, and the markup was fine. The bytes have to decode for this fixture to measure anything.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

test("Markdown local image syntax uses the gated image proxy and local files remain app actions", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      // Both shots: the POSIX one and the Windows one. A proxy URL that 404s is swapped for the plain
      // path by the missing-image handler, so an un-served fixture image measures nothing.
      if (request.url().includes("/_frizz/local-image?path=%2Ffixture%2Fshot.png")
        || request.url().includes("/_frizz/local-image?path=D%3A%2Ffixture%2Fwin-shot.png")) {
        void request.respond({ status: 200, contentType: "image/png", body: PIXEL_PNG })
      } else {
        void request.continue()
      }
    })
    // A desktop Chrome renders PDFs inline, and that is what makes one a document the reader opens. The
    // headless shell has no viewer and says so; stand in for the browser that does.
    await page.evaluateOnNewDocument(() => Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", { configurable: true, get: () => true }))
    await page.goto(`${baseUrl}/local-file-opener-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('button[data-local-path="/fixture/report.md"]')
    const rendered = await page.$eval(".md-body", (node) => {
      const img = node.querySelector("img")
      return {
        buttons: [...node.querySelectorAll("button")].map((b) => b.getAttribute("data-local-path")),
        // The failure this whole page exists to catch is an anchor SURVIVING: a local path left as an
        // href is a same-origin URL, and one click leaves Frizz for a 404. Nothing here may be one.
        anchors: [...node.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        imageSrc: img?.getAttribute("src"),
        imagePath: img?.getAttribute("data-local-path"),
        imageAlt: img?.getAttribute("alt"),
        // A Windows screenshot is proxied exactly like a POSIX one. With no path to proxy it was
        // REMOVED from the prose, so a Windows write-up rendered with its pictures silently missing.
        winImageSrc: node.querySelector('img[alt="windows alt"]')?.getAttribute("src"),
        // The picture is FRAMED, in the one frame every rendered image in the app sits in, and the
        // frame is built from spans so the paragraph marked wraps the image in survives the re-parse.
        framedIn: img?.closest(".md-image-frame")?.tagName,
        frameInsideParagraph: !!img?.closest("p"),
        // The same dot-directory path written in prose: every separator has to survive the render.
        winProse: [...node.querySelectorAll("p")].find((p) => p.textContent?.includes("in prose"))?.textContent,
      }
    })
    assert.deepEqual(rendered, {
      // The last two are the reported bug: a path a worker wrote the way it typed it — relative to the
      // project, and home-anchored — has to arrive here as an absolute local-file button. Before the
      // rebase both stayed relative anchors the browser resolved against the PAGE.
      buttons: [
        "/fixture/report.md",
        "/fixture/contract.pdf",
        "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md",
        "/fixture/home/.claude/CLAUDE.md",
        // The editor deep links: a `cursor://file/…` anchor used to be handed to the OS, which opened
        // Cursor no matter what "Local file links" said. Both slash forms arrive as the path they name.
        "/fixture/plan.md",
        "/fixture/trace.json",
        "/fixture/options.html",
        // Windows destinations carry a path too. The file URL's leading slash stays until the
        // server normalizes it for its own filesystem.
        "D:/fixture/win-report.md",
        "D:\\fixture\\win-trace.json",
        "/D:/fixture/win-plan.md",
        // The `\.` in `fixture\.frizz` is a separator, not a CommonMark escape: the path the button
        // carries is the one the worker wrote, dot-directory and all.
        "D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md",
      ],
      anchors: [],
      imageSrc: "/_frizz/local-image?path=%2Ffixture%2Fshot.png",
      imagePath: "/fixture/shot.png",
      imageAlt: "descriptive alt",
      winImageSrc: "/_frizz/local-image?path=D%3A%2Ffixture%2Fwin-shot.png",
      framedIn: "SPAN",
      frameInsideParagraph: true,
      winProse: "It also lives at D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md in prose.",
    })

    // The ROUTING split, which the markup above deliberately cannot show: both links are the same
    // `data-local-path` button, and only the click decides where each one goes. A `.md` file is prose
    // Frizz renders ITSELF, and a PDF a document it shows in the browser's viewer — both must push the
    // reader drawer and never reach the desktop opener — while any other local file must still be
    // handed to the opener and open no drawer.
    await page.click('button[data-local-path="/fixture/report.md"]')
    await page.click('button[data-local-path="/fixture/contract.pdf"]')
    // And the rebased one routes by the SAME rule — the click handler never learns which syntax the
    // author used, only that the path it holds ends in `.md`.
    await page.click('button[data-local-path="/fixture/.frizz/threads/6d56ea2f/HANDOFF.md"]')
    // And the editor-scheme pair routes by the same rule: the click handler never learns the author
    // wrote a `cursor://`/`vscode://` destination, only the path it named.
    await page.click('button[data-local-path="/fixture/plan.md"]')
    await page.click('button[data-local-path="/fixture/trace.json"]')
    // A linked HTML page goes to the opener, which is the browser: Frizz renders no page itself.
    await page.click('button[data-local-path="/fixture/options.html"]')
    // And the Windows set routes by the same rule, in both separators: `.md` to Frizz's own reader,
    // anything else to the opener. The click handler reads an extension, never a platform.
    await page.click('button[data-local-path="D:/fixture/win-report.md"]')
    await page.click('button[data-local-path="D:\\\\fixture\\\\win-trace.json"]')
    await page.click('button[data-local-path="/D:/fixture/win-plan.md"]')
    // And the dot-directory path reaches the reader with its separator intact.
    await page.click('button[data-local-path="D:\\\\fixture\\\\.frizz\\\\threads\\\\8e51437e\\\\build-gap.md"]')
    const routed = await page.evaluate(() => ({
      opened: (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened ?? [],
      drawers: (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers(),
    }))
    assert.deepEqual(routed, {
      opened: ["/fixture/trace.json", "/fixture/options.html", "D:\\fixture\\win-trace.json"],
      drawers: [
        { kind: "markdown", path: "/fixture/report.md" },
        { kind: "markdown", path: "/fixture/contract.pdf" },
        { kind: "markdown", path: "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md" },
        { kind: "markdown", path: "/fixture/plan.md" },
        { kind: "markdown", path: "D:/fixture/win-report.md" },
        { kind: "markdown", path: "/D:/fixture/win-plan.md" },
        { kind: "markdown", path: "D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md" },
      ],
    })

    // A tool card's header path (PathLink) is the OTHER producer of a local-file link, and it used to
    // be an `<a href="cursor://file/…">` handed straight to the OS — which meant it opened Cursor no
    // matter what "Local file links" said. Nothing on this page may carry an editor-scheme href.
    assert.deepEqual(await page.$$eval('a[href]', (nodes) => nodes.map((n) => n.getAttribute("href"))), [])

    // It routes by the same two rules as the markdown links, and — because the header it sits in is
    // also the disclosure control — the click must open the file and leave the block's state alone.
    const expandedBefore = await page.$eval(".frizz-diff-header", (n) => n.getAttribute("data-expanded"))
    await page.click('.frizz-diff-header button[title="/fixture/src/app.ts"]')
    await page.click('.frizz-diff-header button[title="/fixture/notes.md"]')
    const fromHeaders = await page.evaluate(() => ({
      opened: (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened ?? [],
      drawers: (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers(),
      expanded: document.querySelector(".frizz-diff-header")?.getAttribute("data-expanded"),
    }))
    assert.deepEqual(fromHeaders.opened, [
      "/fixture/trace.json",
      "/fixture/options.html",
      "D:\\fixture\\win-trace.json",
      "/fixture/src/app.ts",
    ])
    assert.deepEqual(fromHeaders.drawers, [
      { kind: "markdown", path: "/fixture/report.md" },
      { kind: "markdown", path: "/fixture/contract.pdf" },
      { kind: "markdown", path: "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md" },
      { kind: "markdown", path: "/fixture/plan.md" },
      { kind: "markdown", path: "D:/fixture/win-report.md" },
      { kind: "markdown", path: "/D:/fixture/win-plan.md" },
      { kind: "markdown", path: "D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md" },
      { kind: "markdown", path: "/fixture/notes.md" },
    ])
    assert.equal(fromHeaders.expanded, expandedBefore)

    // A WIDE /full window, where the reader opens beside the thread: other text now opens there as
    // source, but an HTML page still goes to the browser. Before 2026-11-02 the page's width alone
    // decided, so the same link rendered on a narrow window and showed its source on a wide one.
    type SplitWindow = { __localFileFixtureOpened?: string[]; __localFileFixturePanels: () => string[]; __localFileFixtureSplit: (on: boolean) => void }
    await page.evaluate(() => (window as unknown as SplitWindow).__localFileFixtureSplit(true))
    await page.click('button[data-local-path="/fixture/options.html"]')
    // The control: proves the split is live, so the page's route is the HTML rule and not a narrow window.
    await page.click('button[data-local-path="/fixture/trace.json"]')
    await page.waitForFunction(() => (window as unknown as SplitWindow).__localFileFixturePanels().length > 0)
    const wide = await page.evaluate(() => ({
      opened: (window as unknown as SplitWindow).__localFileFixtureOpened ?? [],
      panels: (window as unknown as SplitWindow).__localFileFixturePanels(),
    }))
    assert.deepEqual(wide.opened.slice(fromHeaders.opened.length), ["/fixture/options.html"])
    assert.deepEqual(wide.panels, ["/fixture/trace.json"])

    // ON A PHONE the desktop opener is the wrong machine, and the server serves a page only as a
    // download, so a page opens as source in the reader, as any other text file does there.
    const phone = await browser.newPage()
    phone.on("pageerror", (error) => pageErrors.push(String(error)))
    await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await phone.goto(`${baseUrl}/local-file-opener-fixture.html`, { waitUntil: "domcontentloaded" })
    await phone.waitForSelector('button[data-local-path="/fixture/options.html"]')
    await phone.click('button[data-local-path="/fixture/options.html"]')
    await phone.waitForFunction(() => (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers().length > 0)
    assert.deepEqual(await phone.evaluate(() => ({
      opened: (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened ?? [],
      drawers: (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers(),
    })), { opened: [], drawers: [{ kind: "markdown", path: "/fixture/options.html" }] })

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
