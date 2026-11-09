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
//   1. The card states the steps in order, as markdown, under an "Awaiting human" kind line and the worker's
//      heading (the kind alone when the worker named none), ruled off from the body, in the paragraph's own
//      colour, one box per step: no Snooze, no button, no text box of its own.
//   2. Ticking a box STAGES an answer, as picking a question's option does: the tick is saved, nothing is sent,
//      the prompt box arms its Send and says it will carry a note, and a second click unticks it.
//   3. The prompt box sends it: every box ticked is the word alone, part of them is a checklist, and a typed
//      note rides under either in the same reply, bound to the thread's session, and the card leaves the
//      queue. Enter on a ticked box itself is the same send, whether it was ticked by click or by key.
//   4. What was finished at an earlier rest folds away, and stays one click off.

const CARD = "[data-awaiting-background]"
const LIST = `${CARD} [data-awaiting-steps]`
const BOX = `${LIST} li:first-child button[role=checkbox]`
const FIRST = "Run `npm login --auth-type=web` in a terminal on this machine."
const ONE_OF_THREE = `Done 1 of 3:\n- [x] ${FIRST}\n- [ ] Approve the browser prompt with the **acme-bot** account.\n- [ ] Reply here once \`npm whoami\` prints \`acme-bot\`.`
const COMPOSER = "textarea[data-surface='queueComposer']"
const SEND = "[data-send-split] [data-send]"

type Sent = { rpc: string; body: { slug?: string; sessionId?: string; message?: string; id?: string; done?: boolean; todos?: { id: string; done: boolean }[] } }

test("a steps card's checklist stages an answer the prompt box sends", {
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
    const checked = () => page.$eval(BOX, (b) => b.getAttribute("aria-checked"))
    const tickAll = async () => {
      for (const b of await page.$$(`${LIST} button[role=checkbox]`)) await b.click()
      await page.waitForFunction((sel) => [...document.querySelectorAll(`${sel} button[role=checkbox]`)].every((b) => b.getAttribute("aria-checked") === "true"), {}, LIST)
    }
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
      text: (el as HTMLElement).innerText,
      counts: [...document.querySelectorAll("[data-ops-count]")].map((c) => c.getAttribute("data-ops-count")),
    }))
    assert.equal(busy.rows, 0, "no wait rows on the card")
    assert.doesNotMatch(busy.text, /acme\/app#39|npm view|Re-check the release/, "nothing the thread is waiting on is named on the card")
    // A monitor is counted with the command watches (`e4148cfe`): one count, its rows telling the shapes apart.
    assert.deepEqual(busy.counts, ["agent", "shell", "pr", "command", "timer"], "every wait is counted over the prompt box instead")
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
        // kind → title → rule → body → list, top to bottom
        order: [top("[data-card-kind]"), top("[data-card-title]"), top("[data-card-rule]"), top(".card-md"), top("[data-awaiting-steps]")],
        proseColour: getComputedStyle(el.querySelector(".card-md p") as Element).color,
        stepColour: getComputedStyle(el.querySelector("[data-awaiting-steps] li") as Element).color,
        stepHeights: [...el.querySelectorAll("[data-awaiting-steps] .frizz-todo-text")].map((t) => t.getBoundingClientRect().height),
        steps: [...el.querySelectorAll("[data-awaiting-steps] .frizz-todo-text")].map((t) => (t as HTMLElement).innerText.trim()),
        code: [...el.querySelectorAll("[data-awaiting-steps] li code")].map((c) => c.textContent),
        strong: [...el.querySelectorAll("[data-awaiting-steps] li strong")].map((c) => c.textContent),
        snooze: !!el.querySelector("[data-awaiting-snooze]"),
        buttons: [...el.querySelectorAll("button:not([role=checkbox])")].map((b) => (b as HTMLElement).innerText.trim()),
        boxes: [...el.querySelectorAll("button[role=checkbox]")].map((b) => document.getElementById(b.getAttribute("aria-labelledby") ?? "")?.textContent?.trim()),
        textBoxes: el.querySelectorAll("textarea, input").length,
      }
    })
    assert.equal(card.kind, "Awaiting human", "the card's kind, on its kind line")
    assert.equal(card.title, "Sign in to npm so the acme 4.2.0 release can publish", "the worker's own heading, under the kind")
    assert.match(card.glyph, /lucide-list-todo/, "the to-do glyph leads the kind line, not the hourglass beside a title")
    assert.ok(card.order.every(Number.isFinite), "the kind, the title, the rule, the body and the list are all drawn")
    assert.deepEqual([...card.order].sort((a, b) => a - b), card.order, "kind, title, rule, body, list — top to bottom")
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
    assert.deepEqual(card.boxes, card.steps, "one box per step, named by its step")
    assert.deepEqual(card.buttons, [], "no button: the prompt box under the card sends the list")
    assert.equal(card.textBoxes, 0, "and no text box of the card's own beside the prompt box")

    // ---- 2. ticking stages, and sends nothing ----
    assert.equal(await checked(), "false")
    assert.deepEqual(await composer(), { placeholder: "Reply to the agent…", armed: false }, "nothing staged, nothing typed: Send is dark")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "true", {}, BOX)
    assert.deepEqual(await composer(), { placeholder: "Add a note to send with your answer…", armed: true }, "the ticked box is a staged answer")
    assert.equal((await rpcs("followUp")).length, 0, "a tick sends nothing")
    assert.deepEqual((await rpcs("setHumanTodo")).map((c) => c.body), [{ slug: "awaiting-bg-demo", id: "step-0", done: true }], "and it is saved")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "false", {}, BOX)
    assert.equal((await composer()).armed, false, "and a second click unticks it")

    const sends = () => page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const gone = () => page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)
    const fresh = async () => {
      await page.reload({ waitUntil: "networkidle0" })
      await page.waitForSelector(BOX)
      await record()
    }

    // ---- once the board has caught up it outranks this tab's copy: a step listed again reopens at once ----
    // (2026-11-09: the tab's copy of a sent tick outlived the report by 5s, so a worker re-listing a step
    // within that window left the box ticked and "1 to-do" with nothing open under it.)
    await fresh()
    await page.click(BOX)
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "setHumanTodo"))
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    await page.evaluate(() => (window as unknown as { __reopenHumanTodo: (id: string) => void }).__reopenHumanTodo("step-0"))
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "false", { timeout: 2_000 }, BOX)

    // ---- 3a. part of the list is a checklist, sent from the empty prompt box ----
    await fresh()
    await page.click(BOX)
    await page.focus(COMPOSER)
    await page.keyboard.press("Enter")
    await sends()
    const partial = await rpcs("followUp")
    assert.equal(partial.length, 1, "one send is one reply")
    assert.equal(partial[0].body.message, ONE_OF_THREE, "the checklist the worker reads")
    assert.deepEqual(partial[0].body.todos, [{ id: "step-0", done: true }, { id: "step-1", done: false }, { id: "step-2", done: false }], "and what the server records")
    assert.equal(partial[0].body.slug, "awaiting-bg-demo")
    assert.equal(partial[0].body.sessionId, "aaaaaaaa-bbbb-cccc-dddd-000000000001", "bound to the session that posted the steps")
    await gone()

    // ---- 3b. the whole list is the word, with a typed note under it, through the Send button ----
    await fresh()
    await tickAll()
    await page.type(COMPOSER, "Signed in as acme-bot.")
    await page.click(SEND)
    await sends()
    const withNote = await rpcs("followUp")
    assert.equal(withNote.length, 1)
    assert.equal(withNote[0].body.message, "Done\n\nSigned in as acme-bot.", "the word, then the human's note under it")
    await gone()

    // ---- 3c. Enter on a ticked box itself sends it, as Enter after picking an option does ----
    // (2026-10-21: a mouse tick left focus on the page body, where Enter reached nothing, and a box holding
    // keyboard focus took Enter as a click and UNticked the answer it was asked to send.)
    const focused = () => page.evaluate((sel) => !!document.activeElement?.closest(sel), LIST)
    for (const [how, tick] of [
      ["clicked", async () => {
        await page.click(BOX)
        // Focus parks on the list, which draws nothing: a mouse tick must not light the keyboard ring.
        assert.deepEqual(await page.$eval(LIST, (list) => ({
          ring: list.querySelector("button")!.matches(":focus-visible"),
          outline: getComputedStyle(list).outlineStyle,
        })), { ring: false, outline: "none" }, "a mouse tick draws no focus ring")
      }],
      // Unticked, Enter is the button's own: it ticks, and sends nothing — there is nothing to send yet.
      ["ticked from the keyboard", async () => {
        await page.focus(BOX)
        await page.keyboard.press("Enter")
        assert.equal(await checked(), "true", "Enter on the unticked box ticks it")
        assert.equal((await rpcs("followUp")).length, 0, "and sends nothing")
      }],
    ] as const) {
      await fresh()
      await tick()
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "true", {}, BOX)
      assert.equal(await focused(), true, `the ${how} box holds focus`)
      await page.keyboard.press("Enter")
      await sends()
      assert.deepEqual((await rpcs("followUp")).map((c) => c.body.message), [ONE_OF_THREE], `Enter on the ${how} box sends the report, once`)
      await gone()
    }

    // …and a caret in the prompt box stays there through a click on the box: it is the note being written.
    await fresh()
    await page.type(COMPOSER, "Signed in.")
    await page.click(BOX)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-checked") === "true", {}, BOX)
    assert.equal(await page.evaluate((c) => document.activeElement === document.querySelector(c), COMPOSER), true, "the caret stays in the prompt box")
    await page.keyboard.press("Enter")
    await sends()
    assert.deepEqual((await rpcs("followUp")).map((c) => c.body.message), [`${ONE_OF_THREE}\n\nSigned in.`])
    await gone()

    // ---- 4. what was finished at an earlier rest folds away, and the report leaves it out ----
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=earlier`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${LIST} li`)
    await record()
    const rows = () => page.$$eval(`${LIST} .frizz-todo-text`, (t) => t.map((el) => (el as HTMLElement).innerText.trim()))
    assert.equal((await rows()).length, 1, "only what is still owed")
    assert.equal(await page.$eval("[data-todos-earlier]", (b) => (b as HTMLElement).innerText), "Show 2 completed")
    await page.click("[data-todos-earlier]")
    assert.equal((await rows()).length, 3, "and the whole list one click off")
    assert.equal(await page.$eval("[data-todos-earlier]", (b) => (b as HTMLElement).innerText), "Hide completed")
    await page.$$eval(`${LIST} li[data-done=false] button[role=checkbox]`, (b) => (b[0] as HTMLButtonElement).click())
    await page.waitForFunction((sel) => !document.querySelector(`${sel} li[data-done=false]`), {}, LIST)
    await page.focus(COMPOSER)
    await page.keyboard.press("Enter")
    await sends()
    const reported = await rpcs("followUp")
    assert.equal(reported[0].body.message, "Done", "everything owed is done, and the steps the worker already knows about are not recited")
    assert.equal(reported[0].body.todos?.length, 1)

    assert.deepEqual(errors, [], "a clean console")
  } finally {
    await browser.close()
  }
})
