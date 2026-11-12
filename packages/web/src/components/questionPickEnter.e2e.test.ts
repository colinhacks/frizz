import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "puppeteer"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5235 --strictPort --host 127.0.0.1 &
//   FRIZZ_QUESTION_PICK_ENTER_E2E_URL=http://127.0.0.1:5235 nub run test packages/web/src/components/questionPickEnter.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUESTION_PICK_ENTER_E2E_URL

// CLICK AN ANSWER, THEN ENTER: IT SENDS, ALWAYS (lib/pickEnter; maintainer 2026-11-12: "If I click on an
// answer inside of a question card and then I hit Enter, it should just submit it, always"). A pick parks
// the focus on the card's options, and that held only while the card stayed mounted: a thread whose
// transcript lands after its questions draws them at the bottom first and then moves them into the
// message that asked them, replacing each card, and a pick made before the move left the focus on
// <body> and Enter sending nothing. The thread in one-send-fixture.html asks two questions; its
// `transcriptDelay` holds the transcript back so there is time to pick before the move.

type Sent = { rpc: string; body: { answers?: { questionId: string; chosen?: string[] }[] } }
const DEPLOY = "Deploy the preview to staging or production?"

async function open(page: Page, query: string, stack: boolean) {
  await page.goto(`${baseUrl}/one-send-fixture.html?${query}`, { waitUntil: "domcontentloaded" })
  // `stack`: wait for the cards at the bottom of the transcript, before it has landed.
  await page.waitForSelector(`${stack ? "[data-registered-questions] " : "[data-frizz-msg] "}[data-question-option]`, { timeout: 60_000 })
  await page.evaluate(() => {
    const w = window as unknown as { __rpc: unknown[] }
    w.__rpc = []
    window.addEventListener("fixture-rpc", (e) => w.__rpc.push((e as CustomEvent).detail))
  })
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __rpc: Sent[] }).__rpc)

/** The centre of the option reading `label` on the card asking `question`, scrolled into view. The card
 *  it sits in is kept on the window, to tell when it has been replaced. */
async function option(page: Page, question: string, label: string) {
  return page.evaluate((q, l) => {
    const card = [...document.querySelectorAll("[data-question-id]")].find((c) => c.textContent?.includes(q))
    const row = [...(card?.querySelectorAll("[data-question-option]") ?? [])].find((o) => o.textContent?.includes(l))
    if (!row) return null
    row.scrollIntoView({ block: "center" })
    ;(window as unknown as { __grid: Element | null }).__grid = row.closest("[data-question-grid]")
    const r = row.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 10) }
  }, question, label)
}

/** Enter, then the beat any send (or a second, stray one) takes to reach the wire. */
async function enter(page: Page) {
  await page.keyboard.press("Enter")
  await new Promise((r) => setTimeout(r, 750))
}

test("Enter after a pick sends it, even when the card was replaced and the focus fell to the page", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 900, height: 1400 })
    // Staged answers live in the draft store, which mirrors into localStorage: every load starts clean.
    await page.evaluateOnNewDocument(() => localStorage.clear())

    // ── The move: pick while the cards sit at the bottom, let the transcript land, then Enter ──
    await open(page, "transcriptDelay=2500", true)
    const before = await option(page, DEPLOY, "Staging")
    assert.ok(before, "the deploy question's options, before the transcript lands")
    await page.mouse.click(before.x, before.y)
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-question-grid")), true, "the pick parks the focus on the options")
    await page.waitForFunction(() => !(window as unknown as { __grid: Element }).__grid.isConnected, { timeout: 30_000 })
    await page.waitForSelector("[data-frizz-msg] [data-question-id]")
    // The precondition this test exists for: without it, it would pass on the options' own Enter.
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "the replaced card took the focus with it")
    await enter(page)
    let calls = await sent(page)
    assert.deepEqual(calls.map((c) => c.rpc), ["followUp"], "one send")
    assert.deepEqual(calls[0].body.answers?.map((a) => [a.questionId, a.chosen]), [["qst_d3pl0y0001", ["Staging"]]], "the pick, with the other question still open")

    // ── The arm is one click long: a click anywhere else, and Enter is that place's again ──
    await open(page, "", false)
    const pick = await option(page, DEPLOY, "Production")
    assert.ok(pick)
    await page.mouse.click(pick.x, pick.y)
    const prose = await page.evaluate(() => {
      const p = [...document.querySelectorAll("[data-frizz-msg] p")].find((n) => n.textContent?.includes("The copy edits are in"))
      const r = p!.getBoundingClientRect()
      return { x: r.left + 4, y: r.top + r.height / 2 }
    })
    await page.mouse.click(prose.x, prose.y)
    await enter(page)
    assert.deepEqual(await sent(page), [], "a click on the prose after the pick spends it")

    // ── A double-click is one pick: the second click does not take it back ──
    await open(page, "", false)
    const twice = await option(page, DEPLOY, "Production")
    assert.ok(twice)
    await page.mouse.click(twice.x, twice.y, { count: 2 })
    await enter(page)
    calls = await sent(page)
    assert.deepEqual(calls.map((c) => c.rpc), ["followUp"], "one send, from the options' own Enter")
    assert.deepEqual(calls[0].body.answers?.map((a) => [a.questionId, a.chosen]), [["qst_d3pl0y0001", ["Production"]]])

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
  }
})
