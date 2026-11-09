import assert from "node:assert/strict"
import test from "node:test"

// The phone thread header's ← is the platform's Back (MobileThreadHeader): it pops when the router
// pushed the thread's entry and closes to the board when the thread arrived by a cold link. Real server,
// real board, real history — each section below is a route that once left a dead or looping Back.
//
// An isolated adhoc-stack seeded by scripts/seed-done-thread.mjs. Never point at a live board:
//   nub scripts/adhoc-stack.mjs --port=<port>        (prints the board url and the sandbox HOME)
//   nub scripts/seed-done-thread.mjs --home=<HOME> --port=<port>
//   FRIZZ_MOBILE_THREAD_BACK_E2E_URL=http://127.0.0.1:<port>/project/<slug> nub --test <this file>
const url = process.env.FRIZZ_MOBILE_THREAD_BACK_E2E_URL
const recordingDir = process.env.FRIZZ_MOBILE_THREAD_BACK_RECORD_DIR

test("mobile thread Back returns direct/reloaded links to their project and pops live navigation", { skip: !url, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(String(error)))
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    const boardPath = new URL(url!).pathname
    const threadUrl = `${url}?thread=done-thread`
    const outside = "data:text/html,<h1>Outside Frizz</h1>"
    const waitForThread = async (slug = "done-thread") => {
      await page.waitForFunction(s => new URLSearchParams(location.search).get("thread") === s, {}, slug)
      await page.waitForSelector("[data-mobile-thread-back]", { visible: true })
      await page.waitForFunction(() => {
        const panel = document.querySelector("[data-mobile-thread-back]")?.closest("[role='dialog']")
        // The Back arrow enters the viewport before the right-edge actions button. Wait for the
        // entire drawer transition, not just the first control becoming hit-testable.
        if (!panel || panel.getAnimations().some(animation => animation.playState === "running")) return false
        return ["[data-mobile-thread-back]", "[data-mobile-thread-more]"].every(selector => {
          const button = document.querySelector(selector)
          if (!button) return false
          const r = button.getBoundingClientRect()
          return r.left >= 0 && r.right <= innerWidth
            && !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(selector)
        })
      })
    }
    const backToBoard = async () => {
      await page.click("[data-mobile-thread-back]")
      await page.waitForFunction(path => location.pathname === path && location.search === "" && !document.querySelector("[data-mobile-thread-back]"), {}, boardPath)
      assert.ok(await page.$("[data-mobile-board]"))
    }
    const openFromBoard = async () => {
      await page.click('[data-mobile-tab="done"]')
      await page.waitForSelector('[data-mobile-thread-row="done-thread"]')
      await page.click('[data-mobile-thread-row="done-thread"]')
      await waitForThread()
    }
    // Back from the board leaves Frizz: there is no second board entry (or a dead same-URL one) under it.
    const backLeavesFrizz = async () => {
      await page.goBack({ waitUntil: "load" })
      assert.equal(page.url(), outside)
    }
    const historyLength = () => page.evaluate(() => history.length)

    // No Frizz entry underneath: a notification/bookmark arriving from another site.
    await page.goto(outside)
    await page.goto(threadUrl, { waitUntil: "networkidle2" })
    await waitForThread()
    await backToBoard()
    await page.click("[data-mobile-projects]")
    await page.waitForFunction(() => location.pathname === "/")
    await page.waitForSelector("[data-mobile-projects-page]")

    // A live push pops, rather than rewriting a second board entry into the history stack.
    await page.goto(outside)
    await page.goto(url!, { waitUntil: "networkidle2" })
    await openFromBoard()
    await backToBoard()
    await backLeavesFrizz()

    // A plain reload on a thread opened from the board: the entry under it is still ours, so ← pops.
    await page.goto(url!, { waitUntil: "networkidle2" })
    await openFromBoard()
    await page.reload({ waitUntil: "networkidle2" })
    await waitForThread()
    await backToBoard()
    await backLeavesFrizz()

    // A sheet's same-URL entry survives reload, but its UI does not. The new document steps off it at
    // boot, so ← lands on the board rather than popping onto the same thread, and Back then leaves.
    await page.goto(url!, { waitUntil: "networkidle2" })
    await openFromBoard()
    await page.click("[data-mobile-thread-more]")
    await page.waitForFunction(() => history.state?.frizzLayer)
    await page.reload({ waitUntil: "networkidle2" })
    await waitForThread()
    await page.waitForFunction(() => !history.state?.frizzLayer)
    const recorder = recordingDir ? await page.screencast({ path: `${recordingDir}/fixed-back.webm` }) : undefined
    try {
      if (recorder) await new Promise(resolve => setTimeout(resolve, 800))
      await backToBoard()
      if (recorder) {
        await new Promise(resolve => setTimeout(resolve, 800))
        await page.screenshot({ path: `${recordingDir}/fixed-board.png` })
      }
    } finally {
      await recorder?.stop()
    }
    await backLeavesFrizz()

    // Stacked layers (a reader over a reader) leave one entry each; every stale one is stepped off.
    await page.goto(url!, { waitUntil: "networkidle2" })
    await openFromBoard()
    await page.evaluate(() => {
      // Tokens a previous document minted: below this one's clock-seeded counter (lib/backDismiss).
      history.pushState({ ...history.state, frizzLayer: 1 }, "")
      history.pushState({ ...history.state, frizzLayer: 2 }, "")
    })
    await page.reload({ waitUntil: "networkidle2" })
    await waitForThread()
    await page.waitForFunction(() => !history.state?.frizzLayer)
    await backToBoard()
    await backLeavesFrizz()

    // A LATERAL move — a thread link followed from inside another thread. The one-drawer policy
    // replaces the first thread, and Back to it used to find it gone, push the second thread's URL back,
    // and flip between the two forever (history 5→6→7→8). The link is the delegated thread-link
    // interceptor's (lib/thread-links), the same path a `[…](/thread/<slug>)` in a transcript takes.
    await page.goto(url!, { waitUntil: "networkidle2" })
    await openFromBoard()
    await page.evaluate(href => {
      const a = document.createElement("a")
      a.href = href
      a.textContent = "the open thread"
      a.setAttribute("data-e2e-thread-link", "")
      document.querySelector("[data-mobile-thread-back]")!.closest("[role='dialog']")!.append(a)
    }, `${boardPath}/thread/open-thread`)
    await page.click("[data-e2e-thread-link]")
    await waitForThread("open-thread")
    const lateralLength = await historyLength()
    await page.click("[data-mobile-thread-back]")
    await waitForThread("done-thread")
    assert.equal(await historyLength(), lateralLength, "← popped back to the first thread; it pushed nothing")
    await backToBoard()
    assert.equal(await historyLength(), lateralLength)
    await backLeavesFrizz()

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
