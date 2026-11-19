import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

// EVERY SIGN-OFF STAYS ON SCREEN WHERE A QUEUED THREAD OPENS, AND THE NEWEST KEEPS ITS CARD (maintainer
// 2026-11-06: "I'll open up a card, and it'll say that 7 rounds have passed … There's clearly one big message
// that was intended for the user to consume, but afterwards, two PR reviews came in"). A worker hands off
// `status: needs_input`, is woken by CI and hands off again, then is woken by a review and by CI and parks
// quietly each time. The server marks the messages each rest signed off on (server sign-offs.ts), and since
// 2026-11-16 every sign-off since the human last spoke stays in view (lib/signOffs stretchSignOffs). Only
// the NEWEST draws its ```awaiting card, though later rounds made its fence stale: it is the wait the thread
// rests on. The earlier hand-off's wait is over, so it keeps its words and draws no card, and the rest reads
// as one card (ThreadSurface useKeptSignOffs). A thread at rest opens on the human's latest message with the
// first sign-off under it (lib/openLanding), in the board's pane and on the full-screen page alike.
//
// Real server, real tailer, real board; the worker is simulated by the transcript the seed writes, which
// also covers a write-up that rested with no fence and was answered by the fence alone after Frizz's
// sign-off reminder:
//   nub scripts/adhoc-stack.mjs --port=<port> > /tmp/stack.log 2>&1 &      # its json line names `home`
//   FRIZZ_SIGNOFF_CARD_E2E_URL=http://127.0.0.1:<port> FRIZZ_SIGNOFF_CARD_E2E_HOME=<home> nub run test <this file>
const baseUrl = process.env.FRIZZ_SIGNOFF_CARD_E2E_URL
const home = process.env.FRIZZ_SIGNOFF_CARD_E2E_HOME

const HANDOFF = "the upload retry fix is ready to merge as acme/app#391"
const HANDOFF_TITLE = "Upload retry fixed, ready to merge"
// The first hand-off, before CI came back: its prose, and the words in its fence body.
const EARLIER = "acme/app#391 makes it back off; CI is running on it."
const EARLIER_BODY = "The approach is in the PR description if you want to look before CI finishes."

test("every sign-off stays on screen in the pane past the quiet rounds after it, and only the newest draws its card", { skip: !baseUrl || !home, timeout: 180_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const first = await api.query("board") as { projectDir: string; projectSlug: string }
  const env = { ...process.env }
  delete env.NODE_COMPAT
  execFileSync("nub", [new URL("../../../../scripts/seed-signoff-under-quiet-parks.mjs", import.meta.url).pathname, home!, first.projectDir], { env, stdio: "inherit" })
  const slugs = ["signoff-buried", "signoff-nudged"]
  let queued = false
  for (let i = 0; i < 120 && !queued; i++) {
    const board = await api.query("board") as { threads: { id: string; needsYou?: boolean }[] }
    queued = slugs.every((slug) => board.threads.find((t) => t.id === slug)?.needsYou === true)
    if (!queued) await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(queued, "both seeded threads are in the queue")

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1100, height: 4000, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    const read = (sel: string) => page.$eval(sel, (el) => ({
      text: (el as HTMLElement).innerText,
      middles: [...el.querySelectorAll('[data-wake-divider="middle-runs-summary"]')].map((d) => (d as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      titles: [...el.querySelectorAll("[data-awaiting-background] [data-card-title]")].map((t) => (t as HTMLElement).innerText.trim()),
    }))

    // Each opens in the board's pane, as a click on its row does, on a layout no earlier run folded.
    await page.goto(`${baseUrl}/project/${first.projectSlug}`, { waitUntil: "domcontentloaded" })
    await page.evaluate(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    for (const slug of slugs) {
      await page.goto(`${baseUrl}/project/${first.projectSlug}?thread=${slug}`, { waitUntil: "networkidle2" })
      const pane = `[data-pane-thread] [data-thread-surface="${slug}"]`
      await page.waitForFunction((sel, handoff) => (document.querySelector(sel) as HTMLElement | null)?.innerText.includes(handoff), { timeout: 30_000 }, pane, HANDOFF)
      const { middles, titles, text } = await read(pane)
      assert.deepEqual(middles, [], `${slug}: the pane folds no rounds away`)
      assert.deepEqual(titles, [HANDOFF_TITLE], `${slug}: the hand-off's own awaiting card is drawn, and no earlier one`)
      assert.ok(text.includes(EARLIER) && text.includes(EARLIER_BODY), `${slug}: the earlier hand-off keeps its words, its fence body's included`)
      // The nudged thread's write-up rested with no fence; the answer to the reminder is what marks it.
      if (slug === "signoff-nudged") assert.ok(text.includes("The write-up is in the message above."), "the fence that answered the reminder stays beside it")
    }

    // The same thread on its full-screen page: every round is drawn there, and the hand-off's card with it.
    await page.goto(`${baseUrl}/project/${first.projectSlug}/thread/signoff-buried`, { waitUntil: "networkidle2" })
    const full = "[data-standalone-thread]"
    await page.waitForFunction((sel, handoff) => (document.querySelector(sel) as HTMLElement | null)?.innerText.includes(handoff), { timeout: 30_000 }, full, HANDOFF)
    const fullRead = await read(full)
    assert.deepEqual(fullRead.titles, [HANDOFF_TITLE], "the full-screen page draws the hand-off's card too, and no earlier one")
    assert.ok(fullRead.text.includes(EARLIER_BODY), "…and the earlier hand-off's words")
    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
  }
})
