import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "puppeteer"
import { BURIED_ANSWERS_HEADER } from "@frizz/shared"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5235 --strictPort --host 127.0.0.1 &
//   FRIZZ_ONE_SEND_E2E_URL=http://127.0.0.1:5235 nub run test packages/web/src/components/oneSend.e2e.test.ts
const baseUrl = process.env.FRIZZ_ONE_SEND_E2E_URL

// ENTER IN THE PROMPT BOX SENDS EVERYTHING STAGED IN THE TRANSCRIPT (lib/sendScope; maintainer
// 2026-10-15: "verify that pressing Enter inside the prompt box also sends all of the answers that have
// been supplied earlier in the transcript"). The thread in one-send-fixture.html asked a question at an
// EARLIER rest, the human replied past it, and the newest rest asks another and hands the human steps.
// Each is answered on its own card, then one Enter in the prompt box must carry all of them — and the
// typed words — as ONE follow-up, and nothing may leave on its own. Pinned on the thread view every
// surface draws, in both question grammars: rows the server registered from ```question fences, and the legacy
// free-form fences beside a row the `ask` tool registered.

type Sent = { rpc: string; body: { slug?: string; message?: string; answers?: { questionId: string; question: string; chosen?: string[]; text?: string }[] } }

const STEPS_BOX = "[data-awaiting-steps] button[role=checkbox]"

async function open(page: Page, query: string) {
  await page.goto(`${baseUrl}/one-send-fixture.html?${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector(STEPS_BOX, { timeout: 60_000 })
  await page.evaluate(() => {
    const w = window as unknown as { __rpc: unknown[] }
    w.__rpc = []
    window.addEventListener("fixture-rpc", (e) => w.__rpc.push((e as CustomEvent).detail))
  })
}

const sent = (page: Page) => page.evaluate(() => (window as unknown as { __rpc: Sent[] }).__rpc)

// THE CARD ASKING `question`. Its root carries no hook of its own, so: from each answer control on the
// page, the nearest ancestor that also holds the question's words — and of those, the smallest. A control
// on this card reaches the card itself; one on any other card has to climb to a container holding both.
const CARD_OF = `(q) => {
  let best = null
  for (const control of document.querySelectorAll("[data-question-grid], textarea[data-surface='questionAnswer']")) {
    let el = control.parentElement
    while (el && !el.textContent.includes(q)) el = el.parentElement
    if (el && (!best || el.textContent.length < best.textContent.length)) best = el
  }
  return best
}`

/** Pick the option whose label reads `label` on the question card asking `question`. */
async function pick(page: Page, question: string, label: string) {
  const clicked = await page.evaluate((cardOf, q, l) => {
    const card = (new Function(`return ${cardOf}`)() as (q: string) => Element | null)(q)
    const option = [...(card?.querySelectorAll("[data-question-option]") ?? [])].find((o) => o.textContent?.includes(l))
    const button = option?.querySelector("button")
    button?.click()
    return !!button
  }, CARD_OF, question, label)
  assert.ok(clicked, `an option "${label}" on "${question}"`)
}

/** Type into the free-text box of the card asking `question`. */
async function answerText(page: Page, question: string, text: string) {
  const box = await page.evaluateHandle((cardOf, q) => {
    const card = (new Function(`return ${cardOf}`)() as (q: string) => Element | null)(q)
    return card?.querySelector("textarea[data-surface='questionAnswer']") ?? null
  }, CARD_OF, question)
  const el = box.asElement() as import("puppeteer").ElementHandle<HTMLTextAreaElement> | null
  assert.ok(el, `a text box on "${question}"`)
  await el.type(text)
}

async function tickSteps(page: Page) {
  await page.click(STEPS_BOX)
  await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-checked") === "true", {}, STEPS_BOX)
}

/** Enter in the prompt box, after typing `note` there (none: an empty box). */
async function enterInPromptBox(page: Page, composer: string, note: string) {
  await page.click(composer)
  if (note) await page.type(composer, note)
  // Every staged answer must have reached the box's Send before Enter can carry it.
  await page.waitForFunction((c) => (document.querySelector(c) as HTMLTextAreaElement | null) === document.activeElement, {}, composer)
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => (window as unknown as { __rpc: unknown[] }).__rpc.length > 0, { timeout: 15_000 })
  // Anything a second, stray send would put on the wire lands within this beat.
  await new Promise((r) => setTimeout(r, 750))
}

test("Enter in the prompt box sends every answer staged anywhere in the transcript, as one turn", {
  skip: !baseUrl,
  timeout: 300_000,
}, async () => {
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

    const DEPLOY = "Deploy the preview to staging or production?"
    const CHANGELOG = "What should the changelog entry say?"

    // THE DRAWER, the registered rows: the question asked at the earlier rest, the one at this rest, the
    // steps box, and a note typed in the box — one Enter.
    await open(page, "")
    await pick(page, DEPLOY, "Staging")
    await answerText(page, CHANGELOG, "Redesigned docs site")
    await tickSteps(page)
    assert.deepEqual(await sent(page), [], "staging an answer sends nothing")
    await enterInPromptBox(page, "textarea[data-surface='chatComposer']", "Approved it from the owner account.")
    let calls = await sent(page)
    assert.deepEqual(calls.map((c) => c.rpc), ["followUp"], "one send, through the prompt box")
    assert.equal(calls[0].body.message, "Done\n\nApproved it from the owner account.", "the steps box's word, with the typed note under it")
    assert.deepEqual(
      calls[0].body.answers?.map((a) => [a.questionId, a.question, a.chosen ?? [], a.text ?? ""]),
      [
        ["qst_d3pl0y0001", DEPLOY, ["Staging"], ""],
        ["qst_ch4ng3l0g1", CHANGELOG, [], "Redesigned docs site"],
      ],
      "both questions' answers ride it — the one asked at the earlier rest included",
    )
    // THE SENT STEPS STAY ON SCREEN, TICKED: the send ends the rest in the render that draws its bubble,
    // so the card is now the record in its message, and its box says what the reply said.
    await page.waitForSelector("[data-awaiting-steps] span[role=checkbox][aria-checked=true]", { timeout: 10_000 })
    assert.equal(await page.$(STEPS_BOX), null, "no live box beside the sent reply")

    // With nothing typed: Enter in the EMPTY box still sends everything staged. (Pinned on the queue
    // card until the card went, 2026-11-10.)
    await open(page, "")
    await pick(page, DEPLOY, "Production")
    await answerText(page, CHANGELOG, "New docs")
    await tickSteps(page)
    await enterInPromptBox(page, "textarea[data-surface='chatComposer']", "")
    calls = await sent(page)
    assert.deepEqual(calls.map((c) => c.rpc), ["followUp"], "one send, through the prompt box")
    assert.equal(calls[0].body.message, "Done", "the steps box's word alone")
    assert.deepEqual(calls[0].body.answers?.map((a) => a.questionId), ["qst_d3pl0y0001", "qst_ch4ng3l0g1"])

    // THE LEGACY GRAMMAR, in the drawer: a free-form fence at the earlier rest, one at this rest, and a
    // row the `ask` tool registered. The fences' answers are composed into the message, the row's ride
    // beside it, and the steps' word and the note close the message.
    await open(page, "legacy=1")
    await pick(page, "Which ORM should the docs examples use?", "Drizzle")
    await pick(page, "Which database should the preview run on?", "Postgres")
    await pick(page, "Which theme should the preview default to?", "Dark")
    await tickSteps(page)
    await enterInPromptBox(page, "textarea[data-surface='chatComposer']", "Approved.")
    calls = await sent(page)
    assert.deepEqual(calls.map((c) => c.rpc), ["followUp"], "one send, through the prompt box")
    assert.equal(
      calls[0].body.message,
      [
        BURIED_ANSWERS_HEADER,
        "1. “Which ORM should the docs examples use?” → A. Drizzle",
        "2. “Which database should the preview run on?” → A. Postgres",
        "",
        "Sent with these answers:",
        "Done",
        "",
        "Approved.",
      ].join("\n"),
      "both fences' answers, then the steps' word and the note",
    )
    assert.deepEqual(calls[0].body.answers?.map((a) => [a.questionId, a.chosen]), [["qst_th3m30001", ["Dark"]]], "the registered row's answer rides beside it")

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
  }
})
