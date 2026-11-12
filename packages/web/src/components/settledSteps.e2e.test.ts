import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5234 --strictPort --host 127.0.0.1 &
//   FRIZZ_SETTLED_STEPS_E2E_URL=http://127.0.0.1:5234 nub --test src/components/settledSteps.e2e.test.ts
const baseUrl = process.env.FRIZZ_SETTLED_STEPS_E2E_URL

// A STEPS CARD OUTLIVES ITS REST (2026-10-08, maintainer: "We need to continue showing the to do
// instructions even after they are complete & the thread has moved on"). Every other settled ```awaiting
// fence draws nothing; one that handed the human `steps:` keeps its card, minus the box nobody is waiting
// on any more. Pinned in the real drawer (settled-steps-fixture.html), whose transcript also holds
// an earlier settled shell wait — the negative control, which must stay invisible in every state.
//
// …AND ITS BOXES SAY WHAT THE REPLY SAID (2026-10-15, maintainer: "we should have something to indicate
// that the awaiting human block … was, in fact, completed") — inert, as a record, from the frame the
// reply's bubble is drawn. A reply in words ticks nothing.

const CARD = "[data-awaiting-background]"
const STEPS = [
  "Run npm login --auth-type=web in a terminal on this machine.",
  "Approve the browser prompt with the acme-bot account.",
]

test("a steps card stays in the transcript after its rest, ticked as its reply said", {
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
    await page.setViewport({ width: 900, height: 1000 })

    const read = async (at: string) => {
      await page.goto(`${baseUrl}/settled-steps-fixture.html?at=${at}`, { waitUntil: "networkidle0" })
      await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
      return page.evaluate((sel) => {
        const cards = [...document.querySelectorAll(sel)] as HTMLElement[]
        return {
          cards: cards.map((el) => ({
            kind: (el.querySelector("[data-card-kind]") as HTMLElement | null)?.innerText.trim(),
            title: (el.querySelector("[data-card-title]") as HTMLElement | null)?.innerText.trim(),
            steps: [...el.querySelectorAll("[data-awaiting-steps] .frizz-todo-text")].map((li) => (li as HTMLElement).innerText.trim()),
            // A box per step, ticked as far as anyone has said. Only a step the list still owes is a control.
            ticks: [...el.querySelectorAll("[data-awaiting-steps] [role=checkbox]")].map((box) => box.getAttribute("aria-checked") === "true"),
            controls: el.querySelectorAll("[data-awaiting-steps] button[role=checkbox]").length,
            // The card's own Send, drawn only where no prompt box sends the list for it.
            send: !!el.querySelector("[data-steps-send]"),
          })),
          // The earlier settled shell wait — card AND prose — must be gone.
          shellProse: document.body.innerText.includes("The release build is running in the background."),
          // …while the steps fence's own prose rides its card, once.
          stepsProse: document.body.innerText.split("The 4.2.0 tag is cut and verified.").length - 1,
          doneBubble: [...document.querySelectorAll("[data-transcript-source-id='u2']")].length,
        }
      }, CARD)
    }

    const stepsCard = { kind: "Awaiting human", title: "Sign in to npm so the acme 4.2.0 release can publish", steps: STEPS }

    // AT REST on the steps: the tail's resting card states them, WITH the box — and the transcript does
    // not draw them a second time above it.
    const rest = await read("rest")
    assert.deepEqual(rest.cards, [{ ...stepsCard, ticks: [false, false], controls: 2, send: false }], "one card, the live one, with its boxes — and the drawer's prompt box to send it")
    assert.equal(rest.shellProse, false, "a settled shell wait still draws nothing")
    assert.equal(rest.stepsProse, 1)

    // Every reply the page sends, by its words.
    const recordSends = () => page.evaluate(() => {
      const w = window as unknown as { __sent: string[] }
      w.__sent = []
      const inner = window.fetch
      window.fetch = async (input, init) => {
        if (String(input instanceof Request ? input.url : input).includes("/_frizz/rpc/followUp")) w.__sent.push(String(JSON.parse(String(init?.body ?? "{}")).message))
        return inner(input, init)
      }
    })
    const sent = () => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent)
    const tick = async () => {
      for (const box of await page.$$("[data-awaiting-steps] button[role=checkbox]")) await box.click()
      await page.waitForFunction(() => [...document.querySelectorAll("[data-awaiting-steps] button[role=checkbox]")].every((box) => box.getAttribute("aria-checked") === "true"))
    }

    // THE DRAWER'S PROMPT BOX sends the ticked box, as the queue card's does.
    await recordSends()
    await tick()
    // Every commit from the Send on: the steps cards on screen, whether one still has its box, and whether
    // the reply's ghost bubble is drawn.
    await page.evaluate((sel) => {
      const w = window as unknown as { __commits: { cards: number; box: boolean; completed: boolean; ghost: boolean }[] }
      w.__commits = []
      new MutationObserver(() => w.__commits.push({
        cards: document.querySelectorAll(`${sel} [data-awaiting-steps]`).length,
        box: !!document.querySelector("[data-awaiting-steps] button[role=checkbox]"),
        completed: document.querySelectorAll("[data-awaiting-steps] span[role=checkbox][aria-checked=true]").length === 2,
        ghost: [...document.querySelectorAll(".bg-user-bubble.opacity-50")].some((el) => el.textContent?.includes("Done")),
      })).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    }, CARD)
    await page.click("[data-send-split] [data-send]")
    await page.waitForFunction(() => (window as unknown as { __sent: string[] }).__sent.length > 0, { timeout: 10_000 })
    assert.deepEqual(await sent(), ["Done"], "one reply, the word")

    // SENT, and the board still says the thread rests on these steps — this fixture's never says otherwise.
    // The send ends the rest in the render that draws its ghost (lib/steering.ts steeredSinceRest), so the live
    // card at the tail becomes the record in its message right there: the steps stay on screen through every
    // commit, and once the ghost is drawn, nobody is waiting on their box.
    await page.waitForFunction(() => document.querySelector(".bg-user-bubble.opacity-50"), { timeout: 10_000 })
    const commits = await page.evaluate(() => (window as unknown as { __commits: { cards: number; box: boolean; completed: boolean; ghost: boolean }[] }).__commits)
    assert.ok(commits.some((c) => c.ghost), "the reply's ghost bubble is drawn")
    assert.deepEqual(commits.filter((c) => c.cards !== 1), [], "the steps are on screen, once, in every commit")
    assert.deepEqual(commits.filter((c) => c.ghost && c.box), [], "no commit draws the ghost beside the live box")
    assert.deepEqual(commits.filter((c) => c.ghost && !c.completed), [], "every commit that draws the ghost draws the ticked record with it")
    assert.deepEqual(commits.filter((c) => !c.box && !c.completed), [], "the box is never missing in between: live, then the record")

    // ON A PHONE the bar under the drawer sends no answers (they have their own sheet), so the card draws
    // its own Send — dark until the box is ticked, and then the same ordinary reply.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    const phone = await read("rest&drawer=1")
    assert.deepEqual(phone.cards, [{ ...stepsCard, ticks: [false, false], controls: 2, send: true }], "the card's own Send, where nothing else sends the list")
    await recordSends()
    assert.equal(await page.$eval("[data-steps-send]", (b) => (b as HTMLButtonElement).disabled), true, "nothing ticked, nothing to send")
    await tick()
    await page.click("[data-steps-send]")
    await page.waitForFunction(() => (window as unknown as { __sent: string[] }).__sent.length > 0, { timeout: 10_000 })
    assert.deepEqual(await sent(), ["Done"], "one reply, the word")
    await page.setViewport({ width: 900, height: 1000 })

    // SENT, worker mid-turn: the card stays where it was, its box ticked and no longer a control.
    const record = (ticks: boolean[]) => ({ ...stepsCard, ticks, controls: 0, send: false })
    const running = await read("running")
    assert.deepEqual(running.cards, [record([true, true])], "the steps stay, with the record that they were done")
    assert.equal(running.shellProse, false)
    assert.equal(running.stepsProse, 1)

    // ANSWERED IN WORDS instead: the steps stay, no box claims they were done — and both are still owed
    // on the list, so the boxes still tick it, though the thread rests on them no longer (2026-11-11,
    // maintainer: "this 'Awaiting Human to Do' list is showing up but isn't clickable").
    const asked = await read("asked")
    assert.deepEqual(asked.cards, [{ ...stepsCard, ticks: [false, false], controls: 2, send: false }], "a reply in words ticks nothing, and leaves the steps to tick")
    // The fixture answers RPCs in the page, so the save is read off its fetch rather than the network.
    await page.evaluate(() => {
      const w = window as unknown as { __saved: { id: string; done: boolean }[] }
      w.__saved = []
      const inner = window.fetch
      window.fetch = async (input, init) => {
        if (String(input instanceof Request ? input.url : input).includes("/_frizz/rpc/setHumanTodo")) {
          const { id, done } = JSON.parse(String(init?.body ?? "{}"))
          w.__saved.push({ id, done })
        }
        return inner(input, init)
      }
    })
    await page.click("[data-awaiting-steps] button[role=checkbox]")
    await page.waitForFunction(() => document.querySelector("[data-awaiting-steps] button[role=checkbox]")?.getAttribute("aria-checked") === "true")
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved), [{ id: "step-0", done: true }], "the tick is the list's, saved at once")
    assert.equal(await page.$$eval("[data-awaiting-steps] [data-human-todo][data-staged=true]", (rows) => rows.length), 1, "and staged for the prompt box's next send")

    // ON A PHONE, with no prompt box to send the list, the settled card draws its own Send, as the resting one does.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    assert.deepEqual((await read("asked&drawer=1")).cards, [{ ...stepsCard, ticks: [false, false], controls: 2, send: true }])
    await page.setViewport({ width: 900, height: 1000 })

    // PART OF THE LIST reported: the record says which part, and the part still owed is still a box.
    assert.deepEqual((await read("partial")).cards, [{ ...stepsCard, ticks: [true, false], controls: 1, send: false }], "the reported step is the record, the owed one a box")

    // THE THREAD MOVED ON to a later rest: still there, still ticked, beside the new resting card.
    const moved = await read("moved")
    assert.equal(moved.cards.length, 2, "the settled steps card and the new resting card")
    assert.deepEqual(moved.cards[0], record([true, true]))
    assert.equal(moved.cards[1].steps.length, 0, "the later rest is a plain wait")
    assert.deepEqual(moved.cards[1].ticks, [], "and carries no box")
    assert.equal(moved.shellProse, false)
    assert.equal(moved.stepsProse, 1)

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
  }
})
