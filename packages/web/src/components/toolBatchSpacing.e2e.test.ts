import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the TOOL-ROW RHYTHM. Skipped unless a Vite URL serving the fixtures is provided
// (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and set
// FRIZZ_TOOL_BATCH_SPACING_E2E_URL to its origin.
//
// The invariant after the minimal renderer: provider batching is invisible while collapsed, and after
// explicit expansion the detailed rows share one rail with no gap, whichever batch each came from. Measured
// in the browser rather than asserted on the tree because both disclosure grouping and row spacing are
// layout behavior.
const baseUrl = process.env.FRIZZ_TOOL_BATCH_SPACING_E2E_URL

const TIGHT = 6
// Two rows on one rail are true DOM neighbours with no gap between them (ChatView ToolRailRows).
const RAIL = 0
// Prose controls: boundaries on either side of a prose-bearing message must NOT be tight. Their exact
// heights are font-dependent, so assert only that they are comfortably wider than the tool run.
const PROSE_MIN = 30

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// Gaps between consecutive tool cards WITHIN one transcript column — the thread's virtualized one
// ([data-virtualized-transcript]) or the sub-agent drawer's plain one ([data-transcript-column]) —
// tagged with WHAT LIES BETWEEN the two cards.
// `nth` picks the column: the drawer mounts OVER the thread, so both are in the DOM at once.
//
// The tag used to be `sameMessage` — do the two cards share a display-message root — on the premise
// that a coalesced run is exactly one root, so crossing one could only mean the real prose break. That
// premise died with the background-launch ejection (2026-08-01): an ejected card is its own display
// message, so a seam now crosses a root for THREE different reasons, only one of which is prose. The
// tag is therefore what actually sits in the gap, which is what decides its height either way.
async function gaps(page: import("puppeteer").Page, nth: number) {
  return page.evaluate((idx) => {
    const scope = document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]")[idx]
    const cards = [...scope.querySelectorAll(".frizz-bash")]
    // Classified by what is PAINTED in the gap, found by geometry — the fixture's prose shares a message
    // root with its own tool band, so "a prose-only message root" would find nothing.
    //   • a digest HEADER is a real row, so a seam spanning one is legitimately taller than the pitch;
    //   • anything else with text in it is PROSE, and prose keeps the full between-block break.
    const inGap = (top: number, bottom: number) =>
      [...scope.querySelectorAll<HTMLElement>("*")].filter((n) => {
        const r = n.getBoundingClientRect()
        return r.height > 0 && r.top >= top - 0.5 && r.bottom <= bottom + 0.5
      })
    const out: { gap: number; spans: "nothing" | "digest" | "prose"; sameRail: boolean; from: string; to: string }[] = []
    for (let i = 1; i < cards.length; i++) {
      const prev = cards[i - 1]
      const cur = cards[i]
      const top = prev.getBoundingClientRect().bottom
      const bottom = cur.getBoundingClientRect().top
      const occupants = inGap(top, bottom)
      // The HEADER ROW specifically — not merely "something inside a disclosure". The spacers BETWEEN
      // an expanded run's cards live inside that same container, so the looser test called every
      // intra-batch seam a digest span and left the tight-pitch assertion measuring one lonely gap.
      const hasDigest = occupants.some((n) => n.matches("[data-tool-activity] button") || n.querySelector("[data-tool-activity] button") !== null)
      const hasProse = occupants.some(
        (n) => (n.textContent ?? "").trim() !== "" && !n.closest("[data-tool-activity]") && !n.closest(".frizz-bash"),
      )
      out.push({
        gap: Math.round((bottom - top) * 10) / 10,
        spans: hasProse ? "prose" : hasDigest ? "digest" : "nothing",
        sameRail: prev.nextElementSibling === cur,
        from: (prev.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
        to: (cur.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
      })
    }
    return out
  }, nth)
}

// A seam with NOTHING painted in it is either two rows on one rail, or two rails at the tight run pitch —
// including the seam into an ejected background card, which is the arrangement the ejection introduced.
const isProseBoundary = (g: { spans: string }) => g.spans === "prose"

for (const [surface, query, column] of [
  ["thread transcript", "", 0],
  // The drawer mounts over the thread, so it is the SECOND column on the page.
  ["sub-agent drawer", "?surface=child", 1],
] as const) {
  test(`${surface}: live gerund stays at the bottom, then settled batches keep one pitch`, {
    skip: !baseUrl,
    timeout: 60_000,
  }, async () => {
    const { browser, page, errors } = await launch()
    try {
      const fixtureUrl = (state: "live" | "gap" | "settled", bg: "running" | "finished" = "running") => {
        const url = new URL("/tool-batch-spacing-fixture.html", baseUrl)
        if (query) url.searchParams.set("surface", "child")
        if (state !== "live") url.searchParams.set("state", state)
        if (bg === "finished") url.searchParams.set("bg", "finished")
        return url.href
      }

      // The bottom slot, read out of whichever column this surface owns.
      const readWorkingSlot = (idx: number) => page.evaluate((i) => {
        const scope = document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]")[i]
        const working = scope.querySelector<HTMLElement>("[data-working-indicator]")
        return {
          workingActivity: working?.dataset.workingActivity,
          shimmerText: working?.querySelector<HTMLElement>(".shimmer-text")?.textContent ?? "",
          digests: scope.querySelectorAll("[data-tool-activity] button").length,
        }
      }, idx)

      await page.goto(fixtureUrl("live"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]").length > n, {}, column)
      await page.waitForFunction((idx) => {
        const scope = document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]")[idx]
        return scope?.querySelector("[data-working-indicator]")?.textContent?.includes("Final workflow validation")
      }, {}, column)
      const live = await page.evaluate((idx) => {
        const scope = document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]")[idx]
        const disclosures = [...scope.querySelectorAll<HTMLElement>("[data-tool-activity] button")]
        const labels = disclosures.map((button) => button.getAttribute("aria-label") ?? "")
        const visibleCards = [...scope.querySelectorAll<HTMLElement>(".frizz-bash")].filter((card) => card.offsetParent !== null).length
        const working = scope.querySelector<HTMLElement>("[data-working-indicator]")
        const shimmer = working?.querySelector<HTMLElement>(".shimmer-text")
        return {
          labels,
          visibleCards,
          workingText: working?.textContent ?? "",
          workingActivity: working?.dataset.workingActivity,
          shimmerText: shimmer?.textContent ?? "",
          pendingDisclosures: scope.querySelectorAll('[data-tool-activity-state="pending"]').length,
        }
      }, column)
      // The ONE visible card is the ejected background launch. Every ORDINARY card stays unmounted
      // behind its disclosure; a detached process is the exception, because its card is the reader's
      // only handle on something still running (lib/toolActivity.isToolActivityException).
      assert.equal(live.visibleCards, 1, "only the ejected background launch renders a card before any disclosure is expanded")
      assert.equal(live.labels.length, 2, "the background launch splits the run it lands in; the live run itself stays out of history")
      assert.match(live.labels[0], /Expand 4 tool calls: Ran 4 tool calls/, "the earlier settled run digests everything up to the background launch")
      assert.match(live.labels[1], /Expand 2 tool calls: Ran 2 tool calls/, "…and resumes as its own digest below it")
      assert.equal(live.workingActivity, "tool", "the ordinary Working slot identifies its tool-label state")
      // Shown AS WRITTEN, not prefixed: `Running` is a claim about what the tool is doing, and pasted
      // in front of a noun phrase it reads as nonsense — so an unconvertible description is only
      // sentence-cased (961cea3 made that the rule and left this expectation behind, red).
      assert.equal(live.shimmerText, "Final workflow validation", "an authored noun-phrase description beats the raw Bash command in the bottom shimmer")
      assert.doesNotMatch(live.workingText, /Working…/, "the gerund replaces rather than accompanies generic Working")
      assert.equal(live.pendingDisclosures, 0, "no historical disclosure may carry live state")

      // The INTER-CALL GAP — the same transcript with that one call's result landed, the turn still
      // running. The gerund is a claim that a tool is executing, so it has to end with the call: what the
      // reader is waiting on now is the model reasoning over what came back, and a stale `Final workflow
      // validation` sat there reading as a tool that had hung (maintainer 2026-08-04). The reading it
      // hands back to STATES THE RUN it is standing in for — the three calls of the live tail — so the
      // gap reads as a turn that has done something and is deciding what is next, not as a thread that
      // has sat thinking since the clock beside it started (maintainer 2026-08-08). History must NOT
      // move in the same beat — the digest count is unchanged from the live pass.
      await page.goto(fixtureUrl("gap"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]").length > n, {}, column)
      await page.waitForFunction((idx) => {
        const scope = document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]")[idx]
        return scope?.querySelector("[data-working-indicator]") !== null
      }, {}, column)
      const gap = await readWorkingSlot(column)
      // Three: the live tail's own calls, the exact set this row expands onto and the exact count the
      // third digest states once the turn settles (asserted below) — so the number never jumps when the
      // withheld run finally lands in history.
      assert.equal(gap.shimmerText, "Ran 3 tool calls. Thinking…", "a landed result hands the bottom slot back to the generic reading, which names the run it is standing in for")
      assert.equal(gap.workingActivity, "generic", "…and the slot reports that it is no longer naming a tool")
      assert.equal(gap.digests, live.labels.length, "the run's digest must not appear in history during the gap")

      await page.goto(fixtureUrl("settled"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]").length > n, {}, column)
      const collapsed = await page.evaluate((idx) => {
        const scope = document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]")[idx]
        const disclosures = [...scope.querySelectorAll<HTMLElement>("[data-tool-activity] button")]
        const labels = disclosures.map((button) => button.getAttribute("aria-label") ?? "")
        // INK, not boxes. This used to read `chevronRect.left - labelRect.right` and pin it to 3–5px,
        // which measured the one thing nobody looks at: the chevron paints 4.67 of its 14 box px, so a
        // 4px BOX gap was 9.06px of ink and the mark floated away from its label. The box gap is now
        // deliberately ~1.3px — transcriptMetaChevronClass collapses the box onto the ink — and the
        // distance that matters is the label's last painted column to the chevron's first.
        const disclosureGeometry = disclosures.map((button) => {
          const label = button.querySelector<HTMLElement>("[data-tool-activity-label]")!
          const chevron = button.querySelector<SVGElement>("[data-tool-activity-chevron]")!
          const buttonRect = button.getBoundingClientRect()
          const chevronRect = chevron.getBoundingClientRect()
          const labelRect = label.getBoundingClientRect()
          const cs = getComputedStyle(label)
          const ctx = document.createElement("canvas").getContext("2d")!
          ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`
          const labelInkRight = labelRect.left + ctx.measureText(label.textContent ?? "").actualBoundingBoxRight
          // An SVG geometry child's rect IS its ink box (stroke included).
          const chevronInk = [...chevron.querySelectorAll("path")].map((p) => p.getBoundingClientRect())
          return {
            inkGap: Math.round((Math.min(...chevronInk.map((r) => r.left)) - labelInkRight) * 10) / 10,
            trailingSpace: Math.round((buttonRect.right - chevronRect.right) * 10) / 10,
          }
        })
        const visibleCards = [...scope.querySelectorAll<HTMLElement>(".frizz-bash")].filter((card) => card.offsetParent !== null).length
        const hasWorkingIndicator = scope.querySelector("[data-working-indicator]") !== null
        disclosures.forEach((button) => button.click())
        return { labels, disclosureGeometry, visibleCards, hasWorkingIndicator }
      }, column)
      assert.equal(collapsed.visibleCards, 1, "settled detail stays unmounted apart from the ejected background launch")
      assert.equal(collapsed.hasWorkingIndicator, false, "settled transcripts have no runtime tail")
      assert.equal(collapsed.labels.length, 3, "two prose-delimited runs, the first of them split by the background launch")
      assert.match(collapsed.labels[0], /Expand 4 tool calls: Ran 4 tool calls/, "the first prose tool tail absorbs provider batches up to the background launch")
      assert.match(collapsed.labels[1], /Expand 2 tool calls: Ran 2 tool calls/, "…and resumes across the batch below it, still presentation-transparent")
      assert.match(collapsed.labels[2], /Expand 3 tool calls: Ran 3 tool calls/, "the second prose tool tail absorbs the following provider batch")
      for (const geometry of collapsed.disclosureGeometry) {
        // ~7px of ink at 14px — clear of the last letter, and half the distance the shimmer keeps to its
        // elapsed clock, so the chevron reads as the label's handle rather than a third mark on the row.
        assert.ok(geometry.inkGap >= 5.5 && geometry.inkGap <= 8.5, `digest chevron must sit beside its label in INK, got ${geometry.inkGap}px`)
        assert.ok(geometry.trailingSpace > 20, "the full transcript row remains the click target after moving the chevron")
      }
      await page.waitForSelector(".frizz-bash")
      await new Promise((r) => setTimeout(r, 600))

      const measured = await gaps(page, column)
      assert.ok(measured.length >= 8, `expected the fixture's full tool column, got ${measured.length} gaps`)

      const tool = measured.filter((g) => g.spans === "nothing")
      for (const g of tool) {
        // Within a sub-pixel: the virtualizer positions the rows either side of a message seam at fractional
        // offsets, so assert the pitch, not the rounding.
        const expected = g.sameRail ? RAIL : TIGHT
        assert.ok(Math.abs(g.gap - expected) < 0.5, `${g.from} → ${g.to} must sit ${g.sameRail ? "on one rail" : "at the tight run"}, got ${g.gap}px`)
      }
      // The expanded detail actually contains adjacent rows — otherwise the assertion above is vacuous.
      assert.ok(tool.filter((g) => g.sameRail).length >= 4, `fixture must contain intra-batch pairs, got ${JSON.stringify(tool)}`)
      // …including the seam INTO the ejected background card. It is a display message of its own, so it
      // is exactly the card that could have opened a paragraph break above itself, and it must not. (Its
      // seam BELOW is not a bare gap — the next run's digest header sits in it — so it is covered by the
      // `digest` class, not here.)
      const ejected = tool.filter((g) => /Waiting for background/.test(g.to))
      assert.equal(ejected.length, 1, `the ejected card must join the tight run above it, got ${JSON.stringify(measured)}`)

      // …and the prose adjacency is NOT collapsed with them.
      const prose = measured.filter(isProseBoundary)
      assert.equal(prose.length, 1, "only the real prose break may split the two expanded activity runs")
      for (const g of prose) {
        assert.ok(g.gap >= PROSE_MIN, `prose boundary must keep its break, got ${g.gap}px`)
      }

      // THE SAME TRANSCRIPT WITH THE BACKGROUND SHELL FINISHED. The card was ejected because it was the
      // reader's handle on something still running; once its completion has landed it draws no mark and
      // reads `done · 45s` exactly like a foreground Bash, and standing alone between two digests it read
      // as "a random uncollapsed bash call" (maintainer 2026-09-12; "Fold it once finished", 2026-09-13).
      // So it folds: the digest/card/digest arrangement above becomes ONE digest carrying all seven.
      await page.goto(fixtureUrl("settled", "finished"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]").length > n, {}, column)
      const folded = await page.evaluate((idx) => {
        const scope = document.querySelectorAll("[data-virtualized-transcript], [data-transcript-column]")[idx]
        const labels = [...scope.querySelectorAll<HTMLElement>("[data-tool-activity] button")].map((button) => button.getAttribute("aria-label") ?? "")
        const visibleCards = [...scope.querySelectorAll<HTMLElement>(".frizz-bash")].filter((card) => card.offsetParent !== null).length
        return { labels, visibleCards }
      }, column)
      assert.equal(folded.visibleCards, 0, "a finished background shell keeps no card of its own")
      assert.equal(folded.labels.length, 2, "…so the run it split is whole again: two prose-delimited runs")
      assert.match(folded.labels[0], /Expand 7 tool calls: Ran 7 tool calls/, "the first run carries the shell and the calls either side of it")
      assert.match(folded.labels[1], /Expand 3 tool calls: Ran 3 tool calls/, "the second run is untouched")

      assert.deepEqual(errors, [], "no console/page errors")
    } finally {
      await browser.close()
    }
  })
}
