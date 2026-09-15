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
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
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
        // The Windows set. Every one of these was a button with NO `data-local-path` — markup that
        // looks right and swallows every click (maintainer 2026-09-14: "file links do not seem to be
        // working"). The `file:` form sheds the URL slash the drive wears, so all three name a file.
        "D:/fixture/win-report.md",
        "D:\\fixture\\win-trace.json",
        "D:/fixture/win-plan.md",
      ],
      anchors: [],
      imageSrc: "/_frizz/local-image?path=%2Ffixture%2Fshot.png",
      imagePath: "/fixture/shot.png",
      imageAlt: "descriptive alt",
      winImageSrc: "/_frizz/local-image?path=D%3A%2Ffixture%2Fwin-shot.png",
      framedIn: "SPAN",
      frameInsideParagraph: true,
    })

    // The ROUTING split, which the markup above deliberately cannot show: both links are the same
    // `data-local-path` button, and only the click decides where each one goes. A `.md` file is prose
    // Frizz renders ITSELF — it must push the reader drawer and never reach the desktop opener — while
    // any other local file must still be handed to the opener and open no drawer.
    await page.click('button[data-local-path="/fixture/report.md"]')
    await page.click('button[data-local-path="/fixture/contract.pdf"]')
    // And the rebased one routes by the SAME rule — the click handler never learns which syntax the
    // author used, only that the path it holds ends in `.md`.
    await page.click('button[data-local-path="/fixture/.frizz/threads/6d56ea2f/HANDOFF.md"]')
    // And the editor-scheme pair routes by the same rule: the click handler never learns the author
    // wrote a `cursor://`/`vscode://` destination, only the path it named.
    await page.click('button[data-local-path="/fixture/plan.md"]')
    await page.click('button[data-local-path="/fixture/trace.json"]')
    // And the Windows set routes by the same rule, in both separators: `.md` to Frizz's own reader,
    // anything else to the opener. The click handler reads an extension, never a platform.
    await page.click('button[data-local-path="D:/fixture/win-report.md"]')
    await page.click('button[data-local-path="D:\\\\fixture\\\\win-trace.json"]')
    await page.click('button[data-local-path="D:/fixture/win-plan.md"]')
    const routed = await page.evaluate(() => ({
      opened: (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened ?? [],
      drawers: (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers(),
    }))
    assert.deepEqual(routed, {
      opened: ["/fixture/contract.pdf", "/fixture/trace.json", "D:\\fixture\\win-trace.json"],
      drawers: [
        { kind: "markdown", path: "/fixture/report.md" },
        { kind: "markdown", path: "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md" },
        { kind: "markdown", path: "/fixture/plan.md" },
        { kind: "markdown", path: "D:/fixture/win-report.md" },
        { kind: "markdown", path: "D:/fixture/win-plan.md" },
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
      "/fixture/contract.pdf",
      "/fixture/trace.json",
      "D:\\fixture\\win-trace.json",
      "/fixture/src/app.ts",
    ])
    assert.deepEqual(fromHeaders.drawers, [
      { kind: "markdown", path: "/fixture/report.md" },
      { kind: "markdown", path: "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md" },
      { kind: "markdown", path: "/fixture/plan.md" },
      { kind: "markdown", path: "D:/fixture/win-report.md" },
      { kind: "markdown", path: "D:/fixture/win-plan.md" },
      { kind: "markdown", path: "/fixture/notes.md" },
    ])
    assert.equal(fromHeaders.expanded, expandedBefore)

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
