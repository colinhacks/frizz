import assert from "node:assert/strict"
import test from "node:test"

// THE SUB-AGENT DRAWER'S HEADER reads like a thread header: "Last active · ◔ context" under the name,
// and the stop as the check at the far right — not a labelled button in a footer of its own — which
// gives way to how the run ended once it has. Driven off subagent-steer-fixture.html, whose mocked RPC
// answers are the router's own shape.
//
//   FRIZZ_SUBAGENT_DRAWER_HEADER_E2E_URL=http://127.0.0.1:<vite port> nub run test <this file>
// or `nub run test:e2e -- <this file>`, which boots the vite itself.
const baseUrl = process.env.FRIZZ_SUBAGENT_DRAWER_HEADER_E2E_URL

test("the sub-agent drawer states its facts in the header and stops from the header's check", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  const errors: string[] = []
  try {
    const open = async (state: string, width = 1200) => {
      const page = await browser.newPage()
      page.on("console", (message) => {
        if (message.type() === "error" && !/404|favicon/i.test(message.text())) errors.push(message.text())
      })
      page.on("pageerror", (error) => errors.push(String(error)))
      await page.setViewport({ width, height: 800, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/subagent-steer-fixture.html?state=${state}`, { waitUntil: "domcontentloaded" })
      await page.evaluate(() => { document.documentElement.dataset.font = "sans" })
      await (await page.waitForSelector("[data-open-drawer]"))!.click()
      await page.waitForSelector("[data-subagent-header-facts] [data-context-meter]")
      // The sheet slides in over 200ms; a click mid-slide has no stable point to land on.
      await new Promise((resolve) => setTimeout(resolve, 300))
      return page
    }
    const header = (page: Awaited<ReturnType<typeof open>>) => page.$eval("[data-subagent-header]", (element) => ({
      text: (element as HTMLElement).innerText,
      height: element.getBoundingClientRect().height,
      stop: !!element.querySelector("[data-stop-subagent]"),
      outcome: element.querySelector("[data-subagent-outcome]")?.getAttribute("data-subagent-outcome") ?? null,
      // The check's INK, from the sheet's right edge: where the thread header's own check sits (21px).
      checkInset: (() => {
        const ink = element.querySelector("[data-stop-subagent] svg path, [data-stop-subagent] svg polyline")?.getBoundingClientRect()
        const sheet = element.closest(".frizz-sheet-panel")?.getBoundingClientRect()
        return ink && sheet ? Math.round(sheet.right - ink.right) : null
      })(),
    }))

    const running = await open("rich")
    const live = await header(running)
    assert.match(live.text, /Last active \d+s ago/)
    assert.match(live.text, /14% context/, "71,733 of 500,000 tokens")
    assert.ok(live.stop, "a stoppable child offers the check in its header")
    assert.equal(live.checkInset, 21)
    assert.equal(live.height, 48, "one pane-header row")
    assert.equal(await running.$("[data-subagent-lifecycle-footer]"), null, "no lifecycle footer under the prompt box")
    await running.click("[data-stop-subagent]")
    await running.waitForSelector("[data-subagent-header] [data-subagent-outcome=killed]")
    const after = await header(running)
    assert.ok(!after.stop, "the check gives way once the child has stopped")
    assert.match(after.text, /Stopped/)

    // A narrow drawer keeps the lone check on the title's row rather than wrapping it onto its own.
    const narrow = await header(await open("rich", 760))
    assert.equal(narrow.height, 48)
    assert.ok(narrow.stop)

    // On a phone the sheet is the whole screen and wears the phone's bar (ui/SheetHeader, since
    // 2026-11-19): the thread header's own 56px, the facts on a second line under the title, and the
    // check still on the bar.
    const phone = await header(await open("rich", 430))
    assert.equal(phone.height, 56, "the phone thread header's height")
    assert.ok(phone.stop)
    assert.match(phone.text, /Last active \d+s ago/)

    for (const [state, outcome, word] of [["settled", "completed", "Finished"], ["stopped", "killed", "Stopped"], ["failed", "failed", "Failed"]] as const) {
      const settled = await header(await open(state))
      assert.equal(settled.outcome, outcome)
      assert.match(settled.text, new RegExp(word))
      assert.ok(!settled.stop, `${state}: nothing left to stop`)
    }

    // A running child the header cannot stop shows no check; its footer says why instead.
    const codex = await open("note-codex")
    assert.ok(!(await header(codex)).stop)
    assert.match(await codex.$eval("[data-subagent-steer-note]", (element) => (element as HTMLElement).innerText), /Codex runs its sub-agents/)

    assert.deepEqual(errors, [], `browser console/page errors: ${errors.join("\n")}`)
  } finally {
    await browser.close()
  }
})
