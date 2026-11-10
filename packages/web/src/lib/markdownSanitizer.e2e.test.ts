import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_MARKDOWN_SANITIZER_E2E_URL

// lib/markdown.ts sanitizes in a real DOM, so this is the only place its behaviour can be pinned.
// Half the value is the XSS battery: `walk` UNWRAPS a disallowed tag rather than deleting its subtree
// (deleting silently ate the rest of any block containing `Promise<void>` or a `<sessionId>`
// placeholder), and every escape route out of that widened rule is re-checked here.
test("the markdown sanitizer keeps authored meaning and blocks every scripted escape", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.goto(`${baseUrl}/markdown-sanitizer-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-case=tasklist]")
    // NOTE: no named function expressions in here. Nub's transpiler rewrites `const f = () => …` with a
    // `__name` keep-names shim that does not exist inside the page, and evaluate dies on it.
    const seen = await page.evaluate(() => {
      const handlers: string[] = []
      for (const el of document.querySelectorAll("*"))
        for (const attr of el.attributes) if (/^on/i.test(attr.name)) handlers.push(`${el.tagName}@${attr.name}`)
      return {
        pwned: (window as Window & { __pwned?: string }).__pwned ?? null,
        handlers,
        // shape
        taskBoxes: Array.from(document.querySelectorAll("[data-case=tasklist] .md-task")).map((n) => n.className),
        // The item's own inline run, wrapped so the row's dimmed/struck styling cannot reach a nested
        // sub-list. Its class has to survive the allowlist like every other one here.
        taskTexts: Array.from(document.querySelectorAll("[data-case=tasklist] .md-task-text")).map((n) => n.textContent),
        nestedStaysOutside: !document.querySelector("[data-case=tasklist-nested] .md-task-text ul"),
        nestedChildText: document.querySelector("[data-case=tasklist-nested] ul ul .md-task-text")?.textContent ?? null,
        emptyBoxes: Array.from(document.querySelectorAll("[data-case=tasklist-empty] .md-task")).map((n) => n.className),
        emptyText: document.querySelector("[data-case=tasklist-empty]")?.textContent?.trim(),
        customTaskBoxes: Array.from(document.querySelectorAll("[data-case=tasklist-custom] .md-task")).map((n) => ({
          className: n.className,
          title: n.getAttribute("title"),
        })),
        looseBoxes: Array.from(document.querySelectorAll("[data-case=tasklist-loose] li > p > .md-task")).map((n) => n.className),
        olStart: document.querySelector("[data-case=olstart] ol")?.getAttribute("start") ?? null,
        headAlign: Array.from(document.querySelectorAll("[data-case=align] th")).map((n) => getComputedStyle(n).textAlign),
        // Each row's cells' bottom rule, top to bottom: the grid draws one under every row but the
        // table's last, whose edge is the frame's own.
        rowRules: Object.fromEntries(["align", "table-head-only", "table-headerless"].map((id) => [
          id,
          Array.from(document.querySelectorAll(`[data-case=${id}] tr`)).map((tr) =>
            Array.from(tr.children).map((cell) => getComputedStyle(cell).borderBottomWidth).join(" ")),
        ])),
        genericText: document.querySelector("[data-case=generic]")?.textContent?.trim(),
        placeholderText: document.querySelector("[data-case=placeholder]")?.textContent?.trim(),
        detailsText: document.querySelector("[data-case=details]")?.textContent?.replace(/\s+/g, " ").trim(),
        // what the walk mints, and what an author may not write
        localLink: Array.from(document.querySelectorAll("[data-case=local-link] button")).map((n) => ({
          className: n.className,
          path: n.getAttribute("data-local-path"),
          text: n.textContent,
        })),
        localImage: Array.from(document.querySelectorAll("[data-case=local-image] img")).map((n) => ({
          path: n.getAttribute("data-local-path"),
          image: n.getAttribute("data-local-image"),
          proxied: (n.getAttribute("src") ?? "").includes("/local-image?path="),
          framed: n.parentElement?.parentElement?.classList.contains("md-image-frame") ?? false,
        })),
        safeLinks: Array.from(document.querySelectorAll("[data-case=safe-links] a")).map((n) => n.getAttribute("href")),
        // Every link left in the page, by the protocol the browser resolved for it.
        linkProtocols: Array.from(new Set(Array.from(document.querySelectorAll("a[href]")).map((n) => (n as HTMLAnchorElement).protocol))).sort(),
        // Every picture that would load from anywhere but the server's own image route.
        foreignImages: Array.from(document.querySelectorAll("img")).map((n) => n.getAttribute("src") ?? "").filter((src) => !src.includes("/local-image?path=")),
        // Every file the escape cases name for the click handler, and every class they kept.
        escapePaths: Array.from(document.querySelectorAll("[data-case^=x-] [data-local-path]")).map((n) => `${n.closest("[data-case]")?.getAttribute("data-case")} ${n.tagName} ${n.getAttribute("data-local-path")}`),
        escapeImageFlags: Array.from(document.querySelectorAll("[data-case^=x-] [data-local-image]")).map((n) => n.tagName),
        overlayClasses: Array.from(document.querySelectorAll("[data-case=x-class-overlay] [class]")).map((n) => n.getAttribute("class") ?? ""),
        overlayPositions: Array.from(document.querySelectorAll("[data-case=x-class-overlay] *")).map((n) => getComputedStyle(n).position).filter((position) => position === "fixed" || position === "absolute"),
        // xss — every one of these must keep the trailing prose and drop the payload
        xss: Object.fromEntries(Array.from(document.querySelectorAll("[data-case^=x-]")).map((n) => [
          n.getAttribute("data-case")!,
          { text: n.textContent?.replace(/\s+/g, " ").trim(), html: n.innerHTML },
        ])),
      }
    })

    // --- nothing executed, nothing scriptable survived ---
    assert.equal(seen.pwned, null, "no probe payload may run")
    assert.deepEqual(seen.handlers, [], "no event-handler attribute may survive sanitizing")
    for (const [id, out] of Object.entries(seen.xss)) {
      assert.doesNotMatch(out.html, /<(script|style|iframe|object|embed|svg|noscript|template|form|input)\b/i, `${id}: dangerous element`)
      assert.doesNotMatch(out.html, /\son[a-z]+=/i, `${id}: event handler`)
      assert.doesNotMatch(out.html, /javascript:/i, `${id}: javascript: url`)
    }
    // a dangerous element takes its content with it; anything else keeps its text
    assert.equal(seen.xss["x-script"].text, "after")
    assert.equal(seen.xss["x-style"].text, "after")
    assert.equal(seen.xss["x-div-script"].text, "kept", "the div unwraps, only the script's content dies")
    assert.equal(seen.xss["x-unknown-handler"].text, "visible text", "an unknown tag unwraps, keeping its text")
    assert.equal(seen.xss["x-deep"].text, "deep text", "unwrapping recurses into salvaged children")
    assert.equal(seen.xss["x-jsurl"].text, "click")
    assert.equal(seen.xss["x-olstart"].html.includes("start="), false, "a non-numeric start is dropped")
    assert.equal(seen.xss["x-tdalign"].html.includes("align="), false, "a bogus align is dropped")
    assert.equal(seen.xss["x-span-style"].html.includes("style="), false, "only an ansi fence's bare hex colour is a style")
    assert.equal(seen.xss["x-span-style"].text, "styled fixed para")
    // a minted button's children are sanitized like any other element's
    assert.equal(seen.xss["x-local-link-img"].text, "after", "the picture inside a local link is not a local one, so it goes")
    assert.equal(seen.xss["x-local-link-nested"].text, "label", "a local link keeps its label and loses the script")
    assert.deepEqual(seen.foreignImages, [], "no picture may load from anywhere but the server's image route")
    // an author names no file and places nothing
    assert.deepEqual(seen.escapePaths, [
      "x-local-link-img BUTTON /tmp/frizz-fixture.txt",
      "x-local-link-remote-img BUTTON /tmp/frizz-fixture.txt",
      "x-local-link-nested BUTTON /tmp/frizz-fixture.txt",
      "x-class-overlay IMG /tmp/frizz-fixture.png",
    ], "data-local-path is minted from the destination, never taken from the author")
    assert.deepEqual(seen.escapeImageFlags, ["IMG"], "data-local-image is minted on a local picture only")
    for (const classes of seen.overlayClasses)
      assert.doesNotMatch(classes, /(?:^|\s)(?:fixed|absolute|inset-0|z-50|opacity-0)(?:\s|$)/, "an author-written class must not survive")
    assert.deepEqual(seen.overlayPositions, [], "nothing an author wrote may leave the flow")
    assert.equal(seen.xss["x-class-overlay"].text, "xparalink", "the overlay's elements stay, as plain content")
    // only web and mail links are links
    assert.deepEqual(seen.linkProtocols, ["http:", "https:", "mailto:"], "every surviving link is http(s) or mailto")
    assert.equal(seen.xss["x-scheme"].text, "abcde f g", "a refused link keeps its label")

    // --- authored meaning survives ---
    assert.deepEqual(seen.taskBoxes, ["md-task md-task-checked", "md-task"], "checked state must be visible")
    assert.deepEqual(seen.customTaskBoxes, [
      { className: "md-task md-task-in-progress", title: "In progress" },
      { className: "md-task md-task-cancelled", title: "Cancelled" },
      { className: "md-task md-task-blocked", title: "Blocked" },
    ], "custom task state and its label must survive sanitizing")
    assert.deepEqual(seen.looseBoxes, ["md-task md-task-checked", "md-task"], "loose task items too")
    assert.deepEqual(seen.taskTexts, ["Reproduce the failing fixture", "Bisect to the offending commit"],
      "each item's own text is wrapped, and the wrapper survives sanitizing")
    assert.ok(seen.nestedStaysOutside, "a nested sub-list must be a SIBLING of the text wrapper, never inside it")
    assert.equal(seen.nestedChildText, "still live", "the live sub-task keeps its own text")
    assert.deepEqual(seen.emptyBoxes, ["md-task", "md-task md-task-checked"],
      "a bare `- [ ]` — an unfilled task-list item — is a checkbox, not literal text")
    assert.equal(seen.emptyText, "", "and it leaves no marker text behind")
    assert.equal(seen.olStart, "17", "a list that starts at 17 keeps its numbering")
    assert.deepEqual(seen.headAlign, ["left", "center", "right"], "GFM column alignment is honored")
    assert.deepEqual(seen.rowRules, {
      // The header row is the last row of its <thead>; it still takes the rule under it.
      align: ["1px 1px 1px", "1px 1px 1px", "0px 0px 0px"],
      "table-head-only": ["0px 0px"],
      "table-headerless": ["1px 1px", "0px 0px"],
    }, "a rule under every table row but the last")
    assert.equal(seen.genericText, "The handler returns Promise and then logs the slug.",
      "a tag-shaped token must not delete the rest of the sentence")
    // The two `<…>` tokens are consumed by the HTML parser (as on GitHub); what must NOT happen is the
    // old behaviour, where everything after the first one was deleted and only "Write to " survived.
    assert.equal(seen.placeholderText, "Write to /.jsonl and restart the tailer.",
      "consecutive placeholders must not delete the rest of the sentence")
    assert.match(seen.detailsText ?? "", /The stack was 40 frames deep/, "a non-allowlisted wrapper keeps its content")
    assert.deepEqual(seen.localLink, [{ className: "local-file-action", path: "/tmp/frizz-fixture.txt", text: "the notes" }],
      "a local link is the button the click handler opens")
    assert.deepEqual(seen.localImage, [{ path: "/tmp/frizz-fixture.png", image: "true", proxied: true, framed: true }],
      "a local picture keeps its path, its proxy URL and its frame")
    assert.deepEqual(seen.safeLinks, ["https://example.invalid/a", "mailto:a@example.invalid", "#top", "/thread/some-slug"],
      "web, mail, anchor and in-app links are untouched")

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
