import assert from "node:assert/strict"
import test from "node:test"

// A PINNED THREAD QUEUES ONLY ITS ASKS (maintainer 2026-11-06). A pinned thread's plain report leaves the
// queue the one-thread pane steps through (ThreadPane.tsx usePaneQueue: j/k, "Open first item", the next
// thread after Done) and the counts, and puts no mark on its row (an unread dot did, from 2026-11-06 to
// 2026-11-09). Its row still opens it in the pane, as every row on a desktop board does. A question or a
// `steps:` list stays in the queue. A report leaves the queue only where a pinned row shows it instead, so
// the Console's two views answer for themselves: By status reads the Console's own pin, and By project
// lifts nothing. Until 2026-11-09 the queue was a column of cards, and this read the cards.
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

test("a pinned thread queues only its asks, and its report waits on the row unmarked", { skip: !baseUrl, timeout: 300_000 }, async () => {
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

    // THE PANE'S QUEUE, read the way a reader walks it: from the empty pane (a fresh load of the page),
    // its heading's count, then `j` until it stops moving. Every step opens a thread, which reads it and
    // dequeues nothing. `at` is the board or the Console; the walk ends back on it with the pane empty.
    const paneSlug = () => page.evaluate(() => document.querySelector("[data-pane-thread] [data-thread-surface]")?.getAttribute("data-thread-surface") ?? null)
    const waiting = () => page.evaluate(() => {
      const empty = document.querySelector("[data-pane-empty]")
      if (!empty) return -1
      return Number(/^(\d+) threads? (?:is|are) waiting/.exec(empty.querySelector("h2")?.textContent ?? "")?.[1] ?? 0)
    })
    const walk = async (at: string) => {
      await page.goto(at, { waitUntil: "networkidle2" })
      await page.waitForSelector("[data-pane-empty]", { timeout: 20_000 })
      const steps: string[] = []
      for (let i = 0; i < 12; i++) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.keyboard.press("j")
        let now: string | null = null
        for (let w = 0; w < 25; w++) {
          now = await paneSlug()
          if (now !== null && now !== steps.at(-1)) break
          await sleep(100)
        }
        if (now === null || now === steps.at(-1)) break
        steps.push(now)
      }
      await page.goto(at, { waitUntil: "networkidle2" })
      return steps
    }
    const waitQueue = async (at: string, want: readonly string[], label: string) => {
      let got: string[] = []
      for (let i = 0; i < 10; i++) {
        await page.goto(at, { waitUntil: "networkidle2" })
        await page.waitForSelector("[data-pane-empty]", { timeout: 20_000 })
        for (let w = 0; w < 30 && (await waiting()) !== want.length; w++) await sleep(100)
        got = await walk(at)
        if ([...got].sort().join() === [...want].sort().join()) return
        await sleep(500)
      }
      assert.deepEqual([...got].sort(), [...want].sort(), label)
    }
    const inPane = (slug: string) => `[data-pane-thread] [data-thread-surface="${slug}"]`
    const noDrawer = async (label: string) => assert.equal(await page.$(".frizz-sheet-panel"), null, label)
    const openRow = async (slug: string) => {
      await page.click(`[data-sidebar-item="${slug}"] button`)
    }

    // 1. Before any pin, all five are in the queue, and the count says so.
    await waitQueue(boardUrl, everyone, "unpinned, every rest queues")
    assert.equal(await queued(), 5)

    // 2. PINNED, the reports leave the queue and the counts. The asks stay, and no row is in neither place.
    for (const t of (await board()).threads) {
      if (everyone.includes(t.id)) await api.mutate("setThreadPinned", { slug: t.id, sessionId: t.sessionId ?? "", pinned: true })
    }
    await waitQueue(boardUrl, asks, "pinned, only the asks queue")
    assert.equal(await queued(), 2)
    await page.waitForSelector(`section[aria-label='Pinned'] [data-pinned-row="${report}"]`, { timeout: 10_000 })
    const shelf = await page.$$eval("section[aria-label='Pinned'] [data-pinned-row]", (rows) => rows.map((r) => r.getAttribute("data-pinned-row")!))
    assert.deepEqual([...shelf].sort(), [...everyone].sort())

    // 3. A report's row opens it in the PANE. Its resting card is drawn there.
    const seenBefore = (await thread(report))?.seenAt ?? ""
    await openRow(report)
    await page.waitForSelector(inPane(report), { timeout: 10_000 })
    await noDrawer("a row on a desktop board opens no drawer")
    await until("opening the thread recorded it", async () => ((await thread(report))?.seenAt ?? "") > seenBefore)
    const seen = await thread(report)
    assert.ok(seen?.seenAt, "opening the thread recorded it")
    assert.equal(seen?.needsYou, true, "reading a report does not change what the thread is resting on")
    assert.ok(
      await page.$eval(inPane(report), (el) => /report|handoff|needs|para/i.test(el.textContent ?? "")),
      "the pane draws the thread's last message",
    )
    await waitQueue(boardUrl, asks, "reading it leaves the queue as it was")

    // 4. An ask's row opens it in the pane as well, and no drawer.
    await openRow(question)
    await page.waitForSelector(inPane(question), { timeout: 10_000 })
    await noDrawer("a queued thread's row opens no drawer either")

    // 5. A NEW REST, with nobody looking, still draws no card.
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
    await waitQueue(boardUrl, asks, "a new report on a pin does not queue")

    // 6. UNPINNED, the report takes its turn in the queue again.
    await api.mutate("setThreadPinned", { slug: done, sessionId: (await thread(done))?.sessionId ?? "", pinned: false })
    await waitQueue(boardUrl, [...asks, done], "unpinned, a report queues again")
    assert.equal(await queued(), 3)
    await api.mutate("setThreadPinned", { slug: done, sessionId: (await thread(done))?.sessionId ?? "", pinned: true })
    await waitQueue(boardUrl, asks, "pinned again")

    // 7. A DEEP LINK to a pinned report opens it in the pane.
    await page.goto(`${boardUrl}?thread=${bare}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(inPane(bare), { timeout: 20_000 })
    await noDrawer("a deep link on a desktop board opens no drawer")

    // 8. ITS FULL PAGE reads it as well, and draws the thread in full.
    await page.goto(`${boardUrl}/thread/${done}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`main[data-standalone-thread] [data-thread-surface="${done}"]`, { timeout: 20_000 })
    await until("the full page recorded the read", async () => {
      const t = await thread(done)
      return Boolean(t?.seenAt && t.lastAssistantAt && t.seenAt > t.lastAssistantAt)
    })

    // 9. THE CONSOLE. By status knows nothing of a board's pin, so the report stays in its queue there, its
    // row in no shelf. Pinned on the Console's own shelf, it leaves that view's queue for its row there.
    // The grouping is set once, not on every document, so the walks' reloads keep the pick made below.
    await send(report, "One for the Console")
    const k = (slug: string) => `${projectSlug}~${slug}`
    const consoleUrl = `${baseUrl}/console`
    await page.evaluate(() => localStorage.setItem("frizz:console-group", "status"))
    await page.goto(consoleUrl, { waitUntil: "networkidle2" })
    await page.waitForSelector(`[data-sidebar-item="${k(report)}"]`, { timeout: 20_000 })
    await waitQueue(consoleUrl, everyone.map(k), "By status, a board pin plays no part")
    await api.mutate("setThreadConsolePinned", { slug: report, sessionId: (await thread(report))?.sessionId ?? "", pinned: true })
    await waitQueue(consoleUrl, everyone.filter((s) => s !== report).map(k), "By status, its own pin takes the report out of the queue")
    await page.waitForSelector(`[data-console-pinned] [data-sidebar-item="${k(report)}"]`, { timeout: 10_000 })
    await page.click("[data-console-sidebar] [data-sidebar-rail] [data-rail-view-chip=\"group\"]")
    await page.waitForSelector('[data-rail-view-option="project"]')
    await page.click('[data-rail-view-option="project"]')
    await waitQueue(consoleUrl, everyone.map(k), "By project lifts nothing, so a report stays in the queue")
    await api.mutate("setThreadConsolePinned", { slug: report, sessionId: (await thread(report))?.sessionId ?? "", pinned: false })

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
