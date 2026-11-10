import assert from "node:assert/strict"
import test from "node:test"
import type { ThemePreference } from "../lib/theme.ts"

// What the page's fixture (mermaid-fixture.tsx) puts on `window`.
declare global {
  interface Window { __chips?: number[]; __setTheme?: (theme: ThemePreference) => void; __setDoc?: (markdown: string) => void; __doc?: string }
}

// Runtime coverage for the ```mermaid fence OUTSIDE the transcript: on every surface that renders a
// worker's Markdown as one string of HTML (components/CodexRichOutput.tsx useMermaidIslands, over
// lib/fenceIslands.ts). Each is its real component on the fixture page, and the diagrams are drawn by the
// real mermaid, loaded through the app's own dynamic import — so this also settles the things only a
// browser can: that `language-mermaid` survives the sanitizer, that a source mermaid cannot parse leaves
// nothing behind but the readable fallback, that a diagram fits the card it is in, and that mermaid is
// not fetched at all until a fence is on screen.
//
// Skipped unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// FRIZZ_MERMAID_E2E_URL to its origin (or run `nub run test:e2e`, which does both).
const baseUrl = process.env.FRIZZ_MERMAID_E2E_URL

const DESKTOP = { width: 1000, height: 900, deviceScaleFactor: 1 }

async function launch(query = "") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport(DESKTOP)
  const errors: string[] = []
  const requested: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("request", (request) => { requested.push(new URL(request.url()).pathname) })
  await page.goto(new URL(`/mermaid-fixture.html${query}`, baseUrl).href, { waitUntil: "networkidle2" })
  return { browser, page, errors, requested }
}

type Page = Awaited<ReturnType<typeof launch>>["page"]

// Every diagram on the page has settled: drawn, or refused with its fallback. `count` is how many the
// page should hold, so a fence that never became an island fails here rather than passing as "settled".
async function settled(page: Page, count: number) {
  await page.waitForFunction((n) =>
    document.querySelectorAll("[data-mermaid-state]").length === n
    && !document.querySelector('[data-mermaid-state="loading"]'), { timeout: 60_000 }, count)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

// The words a diagram drew, in document order — proof it is THIS fence's diagram, not merely an <svg>.
const labels = (page: Page, selector: string) => page.$$eval(`${selector} svg .nodeLabel, ${selector} svg text.messageText, ${selector} svg text.actor`, (els) => els.map((el) => el.textContent!.trim()))

// The mermaid library itself, as opposed to this fixture and the render queue, which share its name.
const loadedMermaid = (requested: string[]) => requested.filter((path) => /\/(?:deps|node_modules)\/.*mermaid/.test(path) || /\/mermaid(?:\.core)?[.-][^/]*\.m?js$/.test(path))

// The cards page: 1 in the done card, 1 refused, 3 in the question (context + two options), 1 narrow,
// 1 uppercase, 1 in the wake, 1 in the reader. The session message's is behind its toggle.
const CARDS = 9

test("a mermaid fence is a diagram on a done card, in a question's context and options, in a wake and in the file reader", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await settled(page, CARDS)
    // No fence is left standing as a code block: each became its island, which is only possible if the
    // sanitizer kept `language-mermaid` on the block.
    assert.equal(await page.$$eval("code.language-mermaid", (els) => els.length), 0)

    // The done card's diagram stands inside the card's own prose, between the paragraphs around the fence.
    assert.deepEqual(await labels(page, '[data-fixture-done] .md-body > .md-mermaid [data-mermaid-state="ready"]'), ["Prompt", "Queue", "Card", "Worker"])
    assert.deepEqual(
      await page.$eval("[data-fixture-done] .md-body", (el) => [...el.children].map((c) => (c.classList.contains("md-mermaid") ? "diagram" : c.tagName))),
      ["P", "diagram", "P"],
    )
    // A question's context, and each option's description.
    assert.deepEqual(
      await page.$$eval("[data-fixture-question] .md-mermaid", (hosts) => hosts.filter((host) => !host.closest("[data-question-option]")).map((host) => [...host.querySelectorAll("svg .nodeLabel")].map((el) => el.textContent!.trim()))),
      [["Prompt", "Queue", "Card", "Worker"]],
    )
    const options = await page.$$("[data-fixture-question] [data-question-option]")
    assert.deepEqual(await options[0].$$eval('.md-mermaid [data-mermaid-state="ready"] svg .nodeLabel', (els) => els.map((el) => el.textContent!.trim())), ["Plan", "web", "server", "shared"])
    assert.equal(await options[1].$$eval('.md-mermaid [data-mermaid-state="ready"] svg .nodeLabel', (els) => els.length), 8)
    assert.equal(await options[2].$$eval(".md-mermaid", (els) => els.length), 0)
    // The info string is matched as the transcript matches it, whatever its case.
    assert.deepEqual(await labels(page, "[data-fixture-uppercase] .md-mermaid"), ["Upper", "Case"])
    // The transcript's two Markdown asides: a wake Frizz could not parse into a divider, and a message
    // from another session, whose body mounts when it is opened.
    assert.deepEqual(await labels(page, "[data-fixture-wake] .md-mermaid"), ["Prompt", "Queue", "Card", "Worker"])
    await page.click("[data-fixture-session] [data-session-message-toggle]")
    await settled(page, CARDS + 1)
    assert.deepEqual(await labels(page, "[data-fixture-session] .md-mermaid"), ["Prompt", "Queue", "Card", "Worker"])
    // The `.md` reader (FileViewerPanel), where the fence sits between a paragraph and a real code block
    // that is still code.
    const reader = await labels(page, "[data-fixture-reader] .md-body > .md-mermaid")
    assert.ok(["Worker", "Frizz", "Human", "ask(question)", "wake"].every((word) => reader.includes(word)), reader.join(" | "))
    assert.equal(await page.$eval("[data-fixture-reader] code.language-typescript", (el) => el.textContent), "await ask({ question })\n")
    // Its Rendered ⇄ Source toggle takes the rendered document out of the page and puts it back with the
    // very same markup, unscanned: the source view shows the fence as text, and the way back draws it again.
    const view = (name: string) => page.evaluate((label) => { [...document.querySelectorAll<HTMLButtonElement>("[data-fixture-reader] button")].find((b) => b.textContent === label)!.click() }, name)
    await view("Source")
    await page.waitForFunction(() => !document.querySelector("[data-fixture-reader] [data-mermaid-state]") && !!document.querySelector("[data-fixture-reader] pre.hljs")?.textContent?.includes("sequenceDiagram"))
    await view("Rendered")
    await settled(page, CARDS + 1)
    assert.ok((await labels(page, "[data-fixture-reader] .md-body > .md-mermaid")).includes("ask(question)"))
    assert.equal(await page.$$eval("[data-fixture-reader] code.language-mermaid", (els) => els.length), 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a source mermaid cannot parse falls back to its code, and a quoted or titled fence stays a code block", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await settled(page, CARDS)
    // The refused fence: one island, in its error state, showing the source it was given and why. No
    // blank box, no thrown error, and nothing of mermaid's own error drawing left in the page.
    const broken = await page.$eval("[data-fixture-broken]", (section) => {
      const islands = [...section.querySelectorAll("[data-mermaid-state]")]
      const box = islands[0]
      return {
        states: islands.map((el) => el.getAttribute("data-mermaid-state")),
        source: box?.querySelector("pre")?.textContent,
        text: box?.textContent ?? "",
        svgs: section.querySelectorAll("svg[id^='frizz-mermaid']").length,
        height: box?.getBoundingClientRect().height ?? 0,
      }
    })
    assert.deepEqual(broken.states, ["error"])
    assert.equal(broken.source, "flowchart LR\n  A --> --> ][")
    assert.match(broken.text, /Diagram unavailable/)
    assert.match(broken.text, /Parse error/)
    assert.equal(broken.svgs, 0)
    assert.ok(broken.height > 60, `the fallback is ${broken.height}px tall`)
    assert.deepEqual(
      await page.evaluate(() => [...document.body.children].filter((el) => el.id !== "root" && el.tagName !== "SCRIPT").map((el) => `${el.tagName}#${el.id}`)),
      [],
      "mermaid left its scratch element in the page",
    )
    assert.equal(await page.evaluate(() => document.body.textContent!.includes("Syntax error in text")), false)

    // A fence being QUOTED — nested in a longer one — is that block's text, under the outer fence's name.
    assert.equal(await page.$eval("[data-fixture-broken] code.language-markdown", (el) => el.textContent), "```mermaid\nflowchart LR\n  Q --> R\n```\n")
    assert.equal(await page.$eval("[data-fixture-reader] code.language-markdown", (el) => el.textContent), "```mermaid\nflowchart LR\n  Q --> R\n```\n")
    // And an info string that says more than `mermaid` is not this fence.
    assert.equal(await page.$eval("[data-fixture-broken] code.language-plaintext", (el) => el.textContent), "flowchart LR\n  T --> U\n")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a diagram fits the card it is in, a tall one is capped inside an answer chip, and clicking one picks the option once", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await settled(page, CARDS)
    // Every drawn diagram: inside its box with nothing to scroll, and the box inside the card that holds it.
    const fit = await page.$$eval('[data-mermaid-state="ready"]', (boxes) => boxes.map((box) => {
      const section = box.closest("section")!
      const svg = box.querySelector("svg")!.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const card = (section.firstElementChild ?? section).getBoundingClientRect()
      return {
        where: section.getAttributeNames().find((name) => name.startsWith("data-fixture"))!,
        scrolls: box.scrollWidth > box.clientWidth,
        svgInside: svg.left >= b.left - 0.5 && svg.right <= b.right + 0.5,
        boxInside: b.left >= card.left - 0.5 && b.right <= card.right + 0.5,
        drawn: svg.width > 0 && svg.height > 0,
        svgHeight: svg.height,
      }
    }))
    assert.equal(fit.length, CARDS - 1)
    for (const f of fit) assert.deepEqual({ ...f, svgHeight: 0 }, { where: f.where, scrolls: false, svgInside: true, boxInside: true, drawn: true, svgHeight: 0 })
    // The 320px card — the queue rail's width — with a diagram six nodes wide: the card did not grow, and
    // neither it nor the page scrolls sideways.
    assert.deepEqual(
      await page.$eval("[data-fixture-narrow]", (section) => ({
        width: section.getBoundingClientRect().width,
        overflows: section.scrollWidth > section.clientWidth || [...section.querySelectorAll("*")].some((el) => el.getBoundingClientRect().right > section.getBoundingClientRect().right + 0.5),
        page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      })),
      { width: 320, overflows: false, page: false },
    )

    // In a chip the diagram steps down with the chip's type, and one eight nodes tall stops at a framed
    // picture's height instead of making the option 800px of flowchart.
    const options = await page.$$("[data-fixture-question] [data-question-option]")
    const chip = (i: number) => options[i].$eval("[data-mermaid-state] svg", (svg) => {
      const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number)
      const r = svg.getBoundingClientRect()
      return { natural: { width, height }, drawn: { width: r.width, height: r.height } }
    })
    const small = await chip(0)
    assert.ok(Math.abs(small.drawn.height / small.natural.height - 11.5 / 14) < 0.01, JSON.stringify(small))
    const tall = await chip(1)
    assert.ok(tall.natural.height > 700, JSON.stringify(tall))
    assert.ok(Math.abs(tall.drawn.height - 420) < 1, JSON.stringify(tall))

    // A diagram opens nothing, so a click on it is a click on the option: it picks it, and exactly once
    // (the stretched button and the row's own handler must not both fire, which would un-pick it).
    // On a NODE of the drawing and on the empty box beside it, which are different hit targets.
    const node = (await options[0].$("[data-mermaid-state] svg .node"))!
    await node.scrollIntoView()
    await node.click()
    assert.deepEqual(await page.evaluate(() => window.__chips), [0])
    const box = (await (await options[0].$("[data-mermaid-state]"))!.boundingBox())!
    await page.mouse.click(box.x + 8, box.y + 8)
    assert.deepEqual(await page.evaluate(() => window.__chips), [0, 0])
    assert.equal(await page.evaluate(() => window.getSelection()!.toString()), "")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a theme change redraws a diagram in place, and a reader's diagram survives a save of the file around it", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await settled(page, CARDS)
    const paint = () => page.$eval("[data-fixture-done] .md-mermaid svg", (svg) => {
      const node = svg.querySelector(".node rect, .node polygon")!
      return { fill: getComputedStyle(node).fill, text: getComputedStyle(svg.querySelector(".nodeLabel")!).color }
    })
    await page.evaluate(() => {
      const host = document.querySelector("[data-fixture-done] .md-mermaid")!
      ;(window as unknown as { __host: Element }).__host = host
      new MutationObserver(() => {
        const state = host.querySelector("[data-mermaid-state]")?.getAttribute("data-mermaid-state")
        if (state !== "ready") (window as unknown as { __flickered: string }).__flickered = String(state)
      }).observe(host, { subtree: true, childList: true, attributes: true })
    })
    const dark = await paint()
    await page.evaluate(() => window.__setTheme!("light"))
    await page.waitForFunction((before) => {
      const node = document.querySelector("[data-fixture-done] .md-mermaid svg .node rect, [data-fixture-done] .md-mermaid svg .node polygon")
      return !!node && getComputedStyle(node).fill !== before
    }, { timeout: 30_000 }, dark.fill)
    await settled(page, CARDS)
    const light = await paint()
    assert.notEqual(light.fill, dark.fill)
    assert.notEqual(light.text, dark.text)
    // Redrawn in the SAME island, which showed the old drawing until the new one was ready: no remount,
    // no placeholder, no flash of the error box.
    assert.equal(await page.evaluate(() => document.querySelector("[data-fixture-done] .md-mermaid") === (window as unknown as { __host: Element }).__host), true)
    assert.equal(await page.evaluate(() => (window as unknown as { __flickered?: string }).__flickered ?? null), null)
    assert.equal(await page.$$eval('[data-mermaid-state="error"]', (els) => els.length), 1)

    // The reader re-renders its whole document when the file is saved. A fence that did not change keeps
    // its mounted diagram — the very same <svg> — rather than dropping to a placeholder and redrawing.
    await page.evaluate(() => { (window as unknown as { __svg: Element }).__svg = document.querySelector("[data-fixture-reader] .md-mermaid svg")! })
    await page.evaluate(() => window.__setDoc!(`${window.__doc}\n\nSaved again, three paragraphs away.\n`))
    await page.waitForFunction(() => document.querySelector("[data-fixture-reader] .md-body")?.textContent?.includes("Saved again"), { timeout: 30_000 })
    assert.equal(await page.evaluate(() => {
      const svg = (window as unknown as { __svg: Element }).__svg
      return svg.isConnected && document.querySelector("[data-fixture-reader] .md-body > .md-mermaid svg") === svg
    }), true)
    // And one whose source DID change is drawn again from the new source.
    await page.evaluate(() => window.__setDoc!(window.__doc!.replace("F-->>W: wake", "F-->>W: resume")))
    await page.waitForFunction(() => [...document.querySelectorAll("[data-fixture-reader] .md-mermaid svg text.messageText")].some((el) => el.textContent === "resume"), { timeout: 30_000 })
    assert.equal(await page.$$eval("[data-fixture-reader] [data-mermaid-state]", (els) => els.length), 1)
    assert.equal(await page.$$eval("[data-fixture-reader] code.language-mermaid", (els) => els.length), 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the Markdown drawer and the thread document draw the fence too", { skip: !baseUrl, timeout: 180_000 }, async () => {
  for (const [query, expected] of [["?mode=markdown", "ask(question)"], ["?mode=thread", "Queue"]] as const) {
    const { browser, page, errors } = await launch(query)
    try {
      await settled(page, 1)
      assert.equal(await page.$$eval("code.language-mermaid", (els) => els.length), 0, query)
      assert.ok((await labels(page, '.md-body > .md-mermaid [data-mermaid-state="ready"]')).includes(expected), query)
      assert.deepEqual(errors, [], query)
    } finally {
      await browser.close()
    }
  }
})

test("mermaid is fetched only once a fence is on screen", { skip: !baseUrl, timeout: 180_000 }, async () => {
  // The same card component with no fence in its body: the library is never requested.
  const plain = await launch("?mode=plain")
  try {
    await plain.page.waitForSelector("[data-fixture-plain] .md-body")
    await plain.page.evaluate(() => new Promise((r) => setTimeout(r, 1500)))
    assert.deepEqual(loadedMermaid(plain.requested), [])
    assert.deepEqual(plain.errors, [])
  } finally {
    await plain.browser.close()
  }
  // The control: with a fence, it is — so the filter above can see it.
  const drawn = await launch("?mode=thread")
  try {
    await settled(drawn.page, 1)
    assert.notDeepEqual(loadedMermaid(drawn.requested), [])
  } finally {
    await drawn.browser.close()
  }
})
