import assert from "node:assert/strict"
import test from "node:test"

// A PINNED THREAD QUEUES ONLY ITS ASKS (maintainer 2026-11-06). A pinned thread's plain report draws no
// queue card and leaves the counts; its row carries an unread dot until the thread is opened, and opening
// that row opens a drawer, since no card is mounted to scroll to. A question or a `steps:` list keeps its
// card. A report loses its card only where a pinned row shows it instead, so the Console's two views answer
// for themselves: By status reads the Console's own pin, and By project lifts nothing.
//
// Real server and broker, the scripted worker (nothing signs in):
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<throwaway repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_PINNED_REPORTS_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// The test dispatches five threads and resumes one; kill the stack's workers with the stack.
const baseUrl = process.env.FRIZZ_PINNED_REPORTS_E2E_URL

type BoardThread = {
  id: string
  sessionId?: string
  runtime: string
  needsYou?: boolean
  plainReport?: boolean
  pinnedAt?: string
  consolePinnedAt?: string
  seenAt?: string
  lastAssistantAt?: string
}
type Board = { projectSlug: string; threads: BoardThread[] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("a pinned thread queues only its asks, and its report waits on the row as unread", { skip: !baseUrl, timeout: 300_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const board = () => api.query("board") as Promise<Board>
  const thread = async (slug: string) => (await board()).threads.find((t) => t.id === slug)
  const until = async (label: string, check: () => Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return
      await sleep(200)
    }
    assert.fail(`timed out: ${label}`)
  }
  const dispatch = async (title: string, ending: string) =>
    ((await api.mutate("dispatch", {
      prompt: `[script ending=${ending} paras=1 think=50 reply=needs replyparas=1 replythink=2500] ${title}`,
      title,
      backend: "claude",
      model: "haiku",
      effort: "low",
    })) as { slug: string }).slug
  const report = await dispatch("Pinned report: a needs_input handoff", "needs")
  const done = await dispatch("Pinned report: a done sign-off", "done")
  const bare = await dispatch("Pinned report: a bare rest", "bare")
  const question = await dispatch("Pinned ask: a question", "question")
  const steps = await dispatch("Pinned ask: a steps list", "steps")
  const reports = [report, done, bare]
  const asks = [question, steps]
  const everyone = [...reports, ...asks]
  await until("every thread queued", async () => {
    const threads = (await board()).threads
    return everyone.every((slug) => threads.find((t) => t.id === slug)?.needsYou === true)
  })

  // THE SERVER'S LINE. Every one of the five queued; three of them ask for nothing.
  const atRest = (await board()).threads
  for (const slug of reports) assert.equal(atRest.find((t) => t.id === slug)?.plainReport, true, `${slug} is a plain report`)
  for (const slug of asks) assert.equal(atRest.find((t) => t.id === slug)?.plainReport, undefined, `${slug} asks`)

  const projectSlug = (await board()).projectSlug
  const boardUrl = `${baseUrl}/project/${projectSlug}`
  const queued = async () => Object.values((await api.query("projectsRailCounts")) as Record<string, { queued: number }>)[0]!.queued

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    await page.goto(boardUrl, { waitUntil: "networkidle2" })
    await page.waitForSelector(`[data-sidebar-item="${report}"]`, { timeout: 20_000 })

    const cards = () => page.$$eval("[data-queue-card]", (els) => els.map((c) => c.getAttribute("data-queue-card")!))
    const waitCards = async (want: readonly string[], label: string) => {
      let got: string[] = []
      for (let i = 0; i < 100; i++) {
        got = await cards()
        if ([...got].sort().join() === [...want].sort().join()) return
        await sleep(100)
      }
      assert.deepEqual([...got].sort(), [...want].sort(), label)
    }
    const dotted = (slug: string, attr = "data-sidebar-item") => page.$eval(`[${attr}="${slug}"]`, (el) => el.querySelector("[data-sidebar-unread]") !== null)
    const waitDot = async (slug: string, want: boolean, label: string, attr?: string) => {
      for (let i = 0; i < 100; i++) {
        if ((await dotted(slug, attr)) === want) return
        await sleep(100)
      }
      assert.equal(await dotted(slug, attr), want, label)
    }
    const drawer = (slug: string) => `.frizz-sheet-panel [data-thread-surface="${slug}"]`
    const openRow = async (slug: string) => {
      await page.click(`[data-sidebar-item="${slug}"] button`)
    }
    const closeDrawer = async (slug: string) => {
      await page.keyboard.press("Escape")
      await until("the drawer closed", async () => (await page.$(drawer(slug))) === null)
    }

    // 1. Before any pin, all five draw a card, and the count says so.
    await waitCards(everyone, "unpinned, every rest cards")
    assert.equal(await queued(), 5)

    // 2. PINNED, the reports leave the queue and the counts. The asks stay, and no row is in neither place.
    for (const t of (await board()).threads) {
      if (everyone.includes(t.id)) await api.mutate("setThreadPinned", { slug: t.id, sessionId: t.sessionId ?? "", pinned: true })
    }
    await waitCards(asks, "pinned, only the asks card")
    assert.equal(await queued(), 2)
    const shelf = await page.$$eval("section[aria-label='Pinned'] [data-pinned-row]", (rows) => rows.map((r) => r.getAttribute("data-pinned-row")!))
    assert.deepEqual([...shelf].sort(), [...everyone].sort())

    // 3. THE UNREAD DOT, on the reports and only on them.
    for (const slug of reports) await waitDot(slug, true, `${slug}: a report nobody has opened is unread`)
    for (const slug of asks) assert.equal(await dotted(slug), false, `${slug}: an ask has its card`)

    // 4. A report's row opens a DRAWER, which clears its dot. Its resting card is still drawn there.
    await openRow(report)
    await page.waitForSelector(drawer(report), { timeout: 10_000 })
    await waitDot(report, false, "opening the thread reads the report")
    const seen = await thread(report)
    assert.ok(seen?.seenAt, "opening the thread recorded it")
    assert.equal(seen?.needsYou, true, "reading a report does not change what the thread is resting on")
    assert.ok(
      await page.$eval(drawer(report), (el) => /report|handoff|needs|para/i.test(el.textContent ?? "")),
      "the drawer draws the thread's last message",
    )
    await closeDrawer(report)
    await waitCards(asks, "closing the drawer leaves the queue as it was")

    // 5. An ask's row still SCROLLS TO ITS CARD, and opens nothing.
    await openRow(question)
    await sleep(300)
    assert.equal(await page.$(drawer(question)), null, "a queued thread's surface is its card")

    // 6. A NEW REST: unread again if nobody was looking, and not if the thread was open when it landed.
    const send = async (slug: string, message: string) => {
      const t = await thread(slug)
      await api.mutate("followUp", { slug, sessionId: t?.sessionId ?? "", message })
    }
    const restedSince = async (slug: string, since: string | undefined) => {
      await until(`${slug} came to rest on a newer report`, async () => {
        const t = await thread(slug)
        return t?.plainReport === true && t.runtime === "turn-idle" && (t.lastAssistantAt ?? "") > (since ?? "")
      })
    }
    const before = (await thread(report))?.lastAssistantAt
    await send(report, "One more, with nobody looking")
    await restedSince(report, before)
    await waitDot(report, true, "a report landing with the thread closed is unread")
    await waitCards(asks, "and it still draws no card")

    await openRow(report)
    await page.waitForSelector(drawer(report), { timeout: 10_000 })
    await waitDot(report, false, "opening it reads it")
    const beforeOpen = (await thread(report))?.lastAssistantAt
    await send(report, "One more, while it is open")
    await restedSince(report, beforeOpen)
    await sleep(1_500)
    assert.equal(await dotted(report), false, "a report read as it lands is never marked")
    await closeDrawer(report)

    // 7. UNPINNED, the report takes its turn in the queue again, and the row has a card to say so.
    await api.mutate("setThreadPinned", { slug: done, sessionId: (await thread(done))?.sessionId ?? "", pinned: false })
    await waitCards([...asks, done], "unpinned, a report cards again")
    assert.equal(await queued(), 3)
    assert.equal(await dotted(done), false)
    await api.mutate("setThreadPinned", { slug: done, sessionId: (await thread(done))?.sessionId ?? "", pinned: true })
    await waitCards(asks, "pinned again")

    // 8. A DEEP LINK to a pinned report opens the drawer; there is no card for it to settle on.
    await page.goto(`${boardUrl}?thread=${bare}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(drawer(bare), { timeout: 20_000 })
    await waitDot(bare, false, "a link reads it too")

    // 9. ITS FULL PAGE reads it as well, and draws the thread in full.
    await page.goto(`${boardUrl}/thread/${done}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`main[data-standalone-thread] [data-thread-surface="${done}"]`, { timeout: 20_000 })
    await until("the full page recorded the read", async () => {
      const t = await thread(done)
      return Boolean(t?.seenAt && t.lastAssistantAt && t.seenAt > t.lastAssistantAt)
    })

    // 10. THE CONSOLE. By status knows nothing of a board's pin, so the report keeps its card there, its
    // row in no shelf. Pinned on the Console's own shelf, it leaves that view's cards for an unread row.
    await send(report, "One for the Console")
    const k = (slug: string) => `${projectSlug}~${slug}`
    await page.evaluateOnNewDocument(() => localStorage.setItem("frizz:console-group", "status"))
    await page.goto(`${baseUrl}/console`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`[data-sidebar-item="${k(report)}"]`, { timeout: 20_000 })
    await waitCards(everyone.map(k), "By status, a board pin plays no part")
    await api.mutate("setThreadConsolePinned", { slug: report, sessionId: (await thread(report))?.sessionId ?? "", pinned: true })
    await waitCards(everyone.filter((s) => s !== report).map(k), "By status, its own pin takes the report's card")
    await page.waitForSelector(`[data-console-pinned] [data-sidebar-item="${k(report)}"] [data-sidebar-unread]`, { timeout: 10_000 })
    await page.click("[data-console-sidebar] [data-sidebar-rail] [data-rail-view-chip=\"group\"]")
    await page.waitForSelector('[data-rail-view-option="project"]')
    await page.click('[data-rail-view-option="project"]')
    await waitCards(everyone.map(k), "By project lifts nothing, so a report keeps its card")
    await api.mutate("setThreadConsolePinned", { slug: report, sessionId: (await thread(report))?.sessionId ?? "", pinned: false })

    // 11. THE PHONE has one list: the shelf leads it, and the row says unread itself.
    await send(bare, "One for the phone")
    await restedSince(bare, (await thread(bare))?.lastAssistantAt)
    const phone = await browser.newPage()
    await phone.setViewport({ width: 420, height: 900, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await phone.goto(boardUrl, { waitUntil: "networkidle2" })
    await phone.waitForSelector(`[data-mobile-thread-row="${bare}"]`, { timeout: 20_000 })
    assert.ok(await phone.$(`[data-mobile-thread-row="${bare}"] [data-mobile-row-unread]`), "an unread report wears the dot on the phone")
    assert.equal(await phone.$(`[data-mobile-thread-row="${question}"] [data-mobile-row-unread]`), null, "an ask does not")
    await phone.close()

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
