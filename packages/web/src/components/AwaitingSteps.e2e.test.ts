import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5233 --strictPort --host 127.0.0.1 &
//   FRIZZ_AWAITING_STEPS_E2E_URL=http://127.0.0.1:5233 nub --test src/components/AwaitingSteps.e2e.test.ts
const baseUrl = process.env.FRIZZ_AWAITING_STEPS_E2E_URL

// STEPS FOR THE HUMAN (2026-10-03): an ```awaiting fence carrying `steps:` draws them on the resting card.
// The steps render through the markdown sanitizer, which needs a real DOM, so this is pinned in a real
// browser against the real queue card (awaiting-bg-fixture.html?steps=…), its own prompt box included.
// Only the RPC answers are stubbed, in the fixture; the send itself goes through the composer's own
// eager follow-up, which is the point:
//
//   1. The card states the steps in order, as markdown, under an "Awaiting human" kind line and the worker's heading
//      (the kind alone when the worker named none), ruled off from the body — in the paragraph's own
//      colour, every item on the same line height whether or not it carries a command — over ONE control,
//      the "I have completed this" box: no Snooze, no button, no text box of its own (2026-10-12).
//   2. Ticking the box STAGES an answer, as picking a question's option does: nothing is sent, the tick
//      survives a reload, the prompt box arms its Send and says it will carry a note, and a second click
//      unticks it.
//   3. The prompt box sends it — Enter in the empty box sends the word alone, and a typed note rides under
//      it in the same reply — bound to the thread's session, and the card leaves the queue. Enter on the
//      ticked box itself is the same send, whether it was ticked by click or by key.

const CARD = "[data-awaiting-background]"
const BOX = `${CARD} [data-steps-complete] button[role=checkbox]`
const COMPOSER = "textarea[data-surface='queueComposer']"
const SEND = "[data-send-split] [data-send]"

type Sent = { rpc: string; body: { slug?: string; sessionId?: string; message?: string } }

test("a steps card's one box stages an answer the prompt box sends", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 900, height: 900 })
    const record = () => page.evaluate(() => {
      ;(window as unknown as { __rpc: unknown[] }).__rpc = []
      window.addEventListener("fixture-rpc", (e) => {
        ;(window as unknown as { __rpc: unknown[] }).__rpc.push((e as CustomEvent).detail)
      })
    })
    const rpcs = (name: string) => page.evaluate((n) => (window as unknown as { __rpc: Sent[] }).__rpc.filter((c) => c.rpc === n), name)
    const box = () => page.$eval(`${CARD} [data-steps-complete]`, (row) => ({
      checked: row.querySelector("button[role=checkbox]")?.getAttribute("aria-checked"),
      label: (row as HTMLElement).innerText.trim(),
    }))
    const composer = () => page.evaluate((c, s) => ({
      placeholder: (document.querySelector(c) as HTMLTextAreaElement | null)?.placeholder,
      armed: !(document.querySelector(s) as HTMLButtonElement | null)?.disabled,
    }), COMPOSER, SEND)

    // ---- an untitled card is headed by its kind line alone ----
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    await page.evaluate(() => localStorage.clear())
    const untitled = await page.$eval(CARD, (el) => ({
      kind: (el.querySelector("[data-card-kind]") as HTMLElement | null)?.innerText.trim(),
      title: !!el.querySelector("[data-card-title]"),
    }))
    assert.deepEqual(untitled, { kind: "Awaiting human", title: false }, "the kind line already says what the card is for")

    // ---- a steps card lists none of the thread's live work; the counts over the prompt box do ----
    // (maintainer 2026-10-15: "you don't need to show all the other shit that it's awaiting … it's also
    // weird that the to-do item is separated from the 'I have completed this' checkbox by a bunch of shit")
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=titled&all=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    const busy = await page.$eval(CARD, (el) => ({
      rows: el.querySelectorAll("[data-wait-row]").length,
      next: el.querySelector("[data-awaiting-steps]")?.nextElementSibling?.hasAttribute("data-steps-complete"),
      text: (el as HTMLElement).innerText,
      counts: [...document.querySelectorAll("[data-ops-count]")].map((c) => c.getAttribute("data-ops-count")),
    }))
    assert.equal(busy.rows, 0, "no wait rows on the card")
    assert.equal(busy.next, true, "the box sits right under the steps it confirms")
    assert.doesNotMatch(busy.text, /acme\/app#39|npm view|Re-check the release/, "nothing the thread is waiting on is named on the card")
    assert.deepEqual(busy.counts, ["agent", "shell", "pr", "command", "monitor", "timer"], "every wait is counted over the prompt box instead")
    for (const [kind, row] of [["command", /npm view acme@4\.2\.0 version[\s\S]*every 5m/], ["timer", /Re-check the release run/]] as const) {
      await page.hover(`[data-ops-count="${kind}"]`)
      await page.waitForSelector(`[data-queue-ops-panel="${kind}"]`)
      assert.match(await page.$eval(`[data-queue-ops-panel="${kind}"]`, (p) => (p as HTMLElement).innerText), row, `the ${kind} count opens its row`)
      await page.mouse.move(0, 0)
      await page.waitForFunction((k) => !document.querySelector(`[data-queue-ops-panel="${k}"]`), {}, kind)
    }

    // ---- 1. the statement ----
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=titled`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    await record()
    const card = await page.$eval(CARD, (el) => {
      const top = (sel: string) => el.querySelector(sel)?.getBoundingClientRect().top ?? NaN
      return {
        kind: (el.querySelector("[data-card-kind]") as HTMLElement | null)?.innerText.trim(),
        title: (el.querySelector("[data-card-title]") as HTMLElement | null)?.innerText.trim(),
        glyph: el.querySelector("[data-card-kind] svg")?.getAttribute("class") ?? "",
        // kind → title → rule → body → box, top to bottom
        order: [top("[data-card-kind]"), top("[data-card-title]"), top("[data-card-rule]"), top(".card-md"), top("[data-steps-complete]")],
        proseColour: getComputedStyle(el.querySelector(".card-md p") as Element).color,
        stepColour: getComputedStyle(el.querySelector("[data-awaiting-steps] li") as Element).color,
        stepHeights: [...el.querySelectorAll("[data-awaiting-steps] .frizz-step-text")].map((t) => t.getBoundingClientRect().height),
        steps: [...el.querySelectorAll("[data-awaiting-steps] .frizz-step-text")].map((t) => (t as HTMLElement).innerText.trim()),
        code: [...el.querySelectorAll("[data-awaiting-steps] li code")].map((c) => c.textContent),
        strong: [...el.querySelectorAll("[data-awaiting-steps] li strong")].map((c) => c.textContent),
        snooze: !!el.querySelector("[data-awaiting-snooze]"),
        buttons: [...el.querySelectorAll("button:not([role=checkbox])")].map((b) => (b as HTMLElement).innerText.trim()),
        boxes: [...el.querySelectorAll("button[role=checkbox]")].map((b) => document.getElementById(b.getAttribute("aria-labelledby") ?? "")?.textContent),
        textBoxes: el.querySelectorAll("textarea, input").length,
      }
    })
    assert.equal(card.kind, "Awaiting human", "the card's kind, on its kind line")
    assert.equal(card.title, "Sign in to npm so the acme 4.2.0 release can publish", "the worker's own heading, under the kind")
    assert.match(card.glyph, /lucide-list-todo/, "the to-do glyph leads the kind line, not the hourglass beside a title")
    assert.ok(card.order.every(Number.isFinite), "the kind, the title, the rule, the body and the box are all drawn")
    assert.deepEqual([...card.order].sort((a, b) => a - b), card.order, "kind, title, rule, body, box — top to bottom")
    assert.equal(card.stepColour, card.proseColour, "one body is one colour: the steps are not brighter than the paragraph above them")
    assert.equal(new Set(card.stepHeights).size, 1, `a step carrying a command is no taller than one without (${card.stepHeights.join(", ")})`)
    assert.deepEqual(card.steps, [
      "Run npm login --auth-type=web in a terminal on this machine.",
      "Approve the browser prompt with the acme-bot account.",
      "Reply here once npm whoami prints acme-bot.",
    ], "every step, in the order the worker wrote them")
    assert.deepEqual(card.code, ["npm login --auth-type=web", "npm whoami", "acme-bot"], "a step is markdown: its code spans are code")
    assert.deepEqual(card.strong, ["acme-bot"])
    assert.equal(card.snooze, false, "the reader is the wait, so there is nothing to snooze until")
    assert.deepEqual(card.boxes, ["I have completed this"], "one box, and the step markers are not boxes of their own")
    assert.deepEqual(card.buttons, [], "no button: the prompt box under the card sends the box")
    assert.equal(card.textBoxes, 0, "and no text box of the card's own beside the prompt box")

    // ---- 2. ticking stages, and sends nothing ----
    assert.deepEqual(await box(), { checked: "false", label: "I have completed this" })
    assert.deepEqual(await composer(), { placeholder: "Reply to the agent…", armed: false }, "nothing staged, nothing typed: Send is dark")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "true", {}, BOX)
    assert.deepEqual(await composer(), { placeholder: "Add a note to send with your answer…", armed: true }, "the ticked box is a staged answer")
    assert.equal((await rpcs("followUp")).length, 0, "a tick sends nothing")
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(BOX)
    assert.equal((await box()).checked, "true", "the tick outlives a reload")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "false", {}, BOX)
    assert.equal((await composer()).armed, false, "and a second click unticks it")
    const stored = await page.evaluate(() => Object.keys((JSON.parse(localStorage.getItem("frizz-drafts:v1") ?? "{}") as { entries?: object }).entries ?? {}).filter((k) => k.startsWith("steps:")))
    assert.deepEqual(stored, [], "an unticked box leaves nothing behind")

    // ---- 3a. Enter in the empty prompt box sends the word alone ----
    await record()
    await page.click(BOX)
    await page.focus(COMPOSER)
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const alone = await rpcs("followUp")
    assert.equal(alone.length, 1, "one send is one reply")
    assert.equal(alone[0].body.message, "Done", "exactly the word, as if the human had typed it")
    assert.equal(alone[0].body.slug, "awaiting-bg-demo")
    assert.equal(alone[0].body.sessionId, "aaaaaaaa-bbbb-cccc-dddd-000000000001", "bound to the session that posted the steps")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)

    // ---- 3b. a typed note rides under it, in the same reply, through the Send button ----
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(BOX)
    assert.equal((await box()).checked, "false", "the send cleared the tick")
    await record()
    await page.click(BOX)
    await page.type(COMPOSER, "Signed in as acme-bot.")
    await page.click(SEND)
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const withNote = await rpcs("followUp")
    assert.equal(withNote.length, 1)
    assert.equal(withNote[0].body.message, "Done\n\nSigned in as acme-bot.", "the word, then the human's note under it")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)

    // ---- 3c. Enter on the ticked box itself sends it, as Enter after picking an option does ----
    // (2026-10-21: a mouse tick left focus on the page body, where Enter reached nothing, and a box holding
    // keyboard focus took Enter as a click and UNticked the answer it was asked to send.)
    const focused = () => page.evaluate((sel) => !!document.activeElement?.closest(sel), `${CARD} [data-steps-complete]`)
    for (const [how, tick] of [
      ["clicked", async () => {
        await page.click(BOX)
        // Focus parks on the row, which draws nothing: a mouse tick must not light the keyboard ring.
        assert.deepEqual(await page.$eval(`${CARD} [data-steps-complete]`, (row) => ({
          ring: row.querySelector("button")!.matches(":focus-visible"),
          outline: getComputedStyle(row).outlineStyle,
        })), { ring: false, outline: "none" }, "a mouse tick draws no focus ring")
      }],
      // Unticked, Enter is the button's own: it ticks, and sends nothing — there is nothing to send yet.
      ["ticked from the keyboard", async () => {
        await page.focus(BOX)
        await page.keyboard.press("Enter")
        assert.equal((await box()).checked, "true", "Enter on the unticked box ticks it")
        assert.equal((await rpcs("followUp")).length, 0, "and sends nothing")
      }],
    ] as const) {
      await page.reload({ waitUntil: "networkidle0" })
      await page.waitForSelector(BOX)
      await record()
      await tick()
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "true", {}, BOX)
      assert.equal(await focused(), true, `the ${how} box holds focus`)
      await page.keyboard.press("Enter")
      await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
      assert.deepEqual((await rpcs("followUp")).map((c) => c.body.message), ["Done"], `Enter on the ${how} box sends the word, once`)
      await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)
    }

    // …and a caret in the prompt box stays there through a click on the box: it is the note being written.
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(BOX)
    await record()
    await page.type(COMPOSER, "Signed in.")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "true", {}, BOX)
    assert.equal(await page.evaluate((c) => document.activeElement === document.querySelector(c), COMPOSER), true, "the caret stays in the prompt box")
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    assert.deepEqual((await rpcs("followUp")).map((c) => c.body.message), ["Done\n\nSigned in."])
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)

    assert.deepEqual(errors, [], "a clean console")
  } finally {
    await browser.close()
  }
})
