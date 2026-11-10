import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for "focusing the free-text box unselects the chosen option" on a REGISTERED
// question (maintainer 2026-08-28: "Focusing the free text option is supposed to unselect the other
// options"). The card's onFocus hands the producer its unchanged text and relies on THAT clearing the
// pick; this producer wrote only the draft and left the chip lit beside a focused box. Skipped unless a
// Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start
// `vite` in packages/web and set FRIZZ_REGISTERED_QUESTION_FOCUS_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_REGISTERED_QUESTION_FOCUS_E2E_URL

type Page = import("puppeteer").Page

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// A real mouse click at the centre of the i-th element `selector` matches. A chip's hit area is a
// stretched button whose mousedown is prevented, so only a pointer click exercises the focus dance the
// bug lives in — `el.click()` would skip it. And a pointer only reaches what is ON SCREEN: `?many=1`
// stacks three cards, so the lower card's rows and box can sit below the 1200px viewport, where a
// click at their centre lands on nothing — the multi checks failed that way once the cards above grew.
// The target scrolls into view before its centre is read.
async function mouseClick(page: Page, selector: string, i = 0) {
  const box = await page.$$eval(selector, (ns, i) => {
    const el = ns[i as number]!
    el.scrollIntoView({ block: "center" })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, i)
  await page.mouse.click(box.x, box.y)
}

// Which option rows of the card wear the selection border, by index.
const selectedRows = (page: Page, card: string) =>
  page.$$eval(`${card} [data-question-option]`, (ns) => ns.flatMap((n, i) => (n.classList.contains("border-selection-border") ? [i] : [])))
const boxFocused = (page: Page, card: string) =>
  page.$eval(`${card} textarea[data-surface='questionAnswer']`, (ta) => document.activeElement === ta)

test("focusing the free-text box unselects a registered question's chosen option; a multi keeps its set", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?many=1`, { waitUntil: "networkidle0" })
    const single = "[data-question-id='qst_0001aaaa']"
    const multi = "[data-question-id='qst_0004dddd']"
    await page.waitForSelector(`${single} [data-question-option]`)
    await page.waitForSelector(`${multi} [data-question-option]`)

    // ── EVERY pixel of a row reads as clickable, because every pixel picks the option ──
    // Sampled by hit test rather than by reading the rule, because the hit test IS the failure: an
    // option's markdown body wears `opacity-90`, which paints it in the positioned layer above the
    // stretched button, so the row showed a pointer on its label line and a plain arrow over every line
    // below it (maintainer 2026-09-03). `?many=1`'s first card is the one with multi-line bodies and a
    // code fence, so the sweep crosses prose, a `pre` and the recommended badge, not just a label.
    const nonPointer = await page.$$eval(`${single} [data-question-option]`, (rows) => {
      const bad: string[] = []
      for (const row of rows) {
        const r = row.getBoundingClientRect()
        for (let y = r.top + 4; y < r.bottom - 2; y += 6) {
          for (const fx of [0.06, 0.3, 0.6, 0.95]) {
            const el = document.elementFromPoint(r.left + r.width * fx, y)
            if (el && getComputedStyle(el).cursor !== "pointer") bad.push(`${el.tagName.toLowerCase()}@${Math.round(y - r.top)}`)
          }
        }
      }
      return bad
    })
    assert.deepEqual(nonPointer, [], "every pixel of a live option row reads as clickable")

    // ── SINGLE: pick B, then click into the box — B must let go ──
    await mouseClick(page, `${single} [data-question-option]`, 1)
    assert.deepEqual(await selectedRows(page, single), [1])
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, single), true)
    assert.deepEqual(await selectedRows(page, single), [])
    // Climbing back out without typing does not resurrect the pick.
    await page.keyboard.press("Escape")
    assert.equal(await boxFocused(page, single), false)
    assert.deepEqual(await selectedRows(page, single), [])
    // A chip click still takes over from a typed answer — but it LEAVES the text. This assertion read
    // the other way until `4a6b5b49` (2026-09-02) deliberately reversed it: the typed draft stays in the
    // box as an unselected draft, and registeredAnswer submits the chip beside it. That commit did not
    // update this test, so it pinned the retired behaviour until 2026-09-03.
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    await page.keyboard.type("neither")
    assert.deepEqual(await selectedRows(page, single), [])
    await mouseClick(page, `${single} [data-question-option]`, 0)
    assert.deepEqual(await selectedRows(page, single), [0])
    assert.equal(await page.$eval(`${single} textarea[data-surface='questionAnswer']`, (ta) => (ta as HTMLTextAreaElement).value), "neither")

    // ── MULTI: the note box only adds colour, so the toggled set survives its focus ──
    await mouseClick(page, `${multi} [data-question-option]`, 0)
    await mouseClick(page, `${multi} [data-question-option]`, 2)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])
    await mouseClick(page, `${multi} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, multi), true)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// WHICH OPTION IS PICKED, AS ASSISTIVE TECH IS TOLD IT. The pick was drawn (the selection border, the
// tick) and never said: an option was a button with a name and no state, in a run of buttons with no
// group, so a screen reader read every option alike and could not say they were one choice (measured
// 2026-11-09: after Space on an option, `{"pressed":null,"checked":null}`). Read from the browser's own
// accessibility tree, which is what a screen reader is handed, not from the attributes.
test("an option says whether it is picked, and the options are a group named by their question", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?many=1`, { waitUntil: "networkidle0" })
    const single = "[data-question-id='qst_0001aaaa']"
    const multi = "[data-question-id='qst_0004dddd']"
    await page.waitForSelector(`${single} [data-question-option]`)
    await page.waitForSelector(`${multi} [data-question-option]`)

    /**
     * The card's options as the accessibility tree has them: the group's role and name, and each
     * option's own button's pressed state (an option's body can hold other buttons: a code block's copy).
     */
    const spoken = async (card: string) => {
      const grid = (await page.$(`${card} [data-question-grid]`))!
      const group = await page.accessibility.snapshot({ root: grid, interestingOnly: false })
      const options: (boolean | "mixed" | undefined)[] = []
      for (const button of await page.$$(`${card} [data-question-option] > button`)) {
        options.push((await page.accessibility.snapshot({ root: button, interestingOnly: false }))?.pressed)
      }
      return { role: group?.role, name: group?.name ?? "", options }
    }
    const count = await page.$$eval(`${single} [data-question-option]`, (rows) => rows.length)
    const none = Array.from({ length: count }, () => false)

    const before = await spoken(single)
    assert.equal(before.role, "group")
    const question = await page.$eval(`${single} .md-body`, (el) => el.textContent!.trim())
    assert.ok(question.length > 10, "the fixture's question has text")
    assert.equal(before.name, question, "the group is named by the question it answers")
    assert.deepEqual(before.options, none, "every option is a toggle, and none is pressed yet")

    // By keyboard, the way a screen-reader user picks: Tab stop on the option's button, Space.
    const press = async (card: string, i: number) => {
      await page.$$eval(`${card} [data-question-option] > button`, (buttons, i) => (buttons[i as number] as HTMLElement).focus(), i)
      await page.keyboard.press("Space")
    }
    await press(single, 1)
    assert.deepEqual((await spoken(single)).options, none.map((_, i) => i === 1))
    assert.deepEqual(await selectedRows(page, single), [1], "what is said is what is drawn")
    // A single choice moves.
    await press(single, 0)
    assert.deepEqual((await spoken(single)).options, none.map((_, i) => i === 0))
    // And picking the chosen option again lets it go, which is why these are toggles and not radios.
    await press(single, 0)
    assert.deepEqual((await spoken(single)).options, none)

    // A multi says each one it holds.
    await press(multi, 0)
    await press(multi, 2)
    const multiSpoken = await spoken(multi)
    assert.equal(multiSpoken.role, "group")
    assert.deepEqual(multiSpoken.options.slice(0, 3), [true, false, true])
    assert.deepEqual(await selectedRows(page, multi), [0, 2])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
