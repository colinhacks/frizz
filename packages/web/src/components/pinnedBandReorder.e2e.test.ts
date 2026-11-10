import assert from "node:assert/strict"
import test from "node:test"

// THE PINNED BAND REORDERS BY DRAG (Sidebar.tsx PinnedBand): a row held and moved slides the rows it
// passes aside, the drop is the band's new order at once, the server keeps it across a reload, and the
// click the browser fires on release does not open the dropped row. Alt+↑/↓ moves a focused row one slot.
// Only a real browser shows any of it: pointer capture, the release click, and rows whose heights differ
// (a two-line title, a live sub-agent hanging under its thread) measured where they actually laid out.
//
// Real server, real broker; the worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_PINNED_REORDER_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// The test dispatches four threads and pins three of them, unpinning anything an earlier run left. The one with a sub-agent keeps it for two
// minutes; kill the stack's workers with the stack.
const baseUrl = process.env.FRIZZ_PINNED_REORDER_E2E_URL

type BoardThread = { id: string; sessionId?: string; runtime: string; pinnedAt?: string }

test("a pinned row dragged to a new slot stays there, across a reload, without opening the row", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const board = () => api.query("board") as Promise<{ projectSlug: string; threads: BoardThread[] }>
  const dispatch = (title: string, script: string) =>
    api.mutate("dispatch", { prompt: `[script ${script}] ${title}`, title, backend: "claude", model: "haiku", effort: "low" }) as Promise<{ slug: string }>
  const { slug: a } = await dispatch("Pinned alpha", "ending=needs paras=1")
  const { slug: b } = await dispatch(
    "Pinned beta, whose title is long enough to wrap onto a second line of the sidebar at this width so its row is taller",
    "ending=needs paras=1",
  )
  const { slug: c } = await dispatch("Pinned gamma", "ending=needs paras=1 agents=1 agentsteps=4 agentms=120000")
  const { slug: loose } = await dispatch("Not pinned", "ending=needs paras=1")
  let projectSlug = ""
  for (let i = 0; i < 160 && !projectSlug; i++) {
    const snapshot = await board()
    const runtime = (id: string) => snapshot.threads.find((t) => t.id === id)?.runtime
    if ([a, b, loose].every((id) => runtime(id) === "turn-idle") && runtime(c)) projectSlug = snapshot.projectSlug
    else await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(projectSlug, "the scripted threads came to rest")
  // A stack that has run this before still holds its pins: the band is this run's three alone.
  for (const t of (await board()).threads) {
    if (typeof t.pinnedAt === "string") await api.mutate("setThreadPinned", { slug: t.id, sessionId: t.sessionId ?? "", pinned: false })
  }
  // Pinned one at a time, so the instants (and the band) read alpha, beta, gamma.
  for (const slug of [a, b, c]) {
    const sessionId = (await board()).threads.find((t) => t.id === slug)?.sessionId ?? ""
    await api.mutate("setThreadPinned", { slug, sessionId, pinned: true })
    await new Promise((r) => setTimeout(r, 5))
  }
  // The server's own order: the one the board sorts the band by.
  const serverOrder = async () =>
    (await board()).threads
      .filter((t) => typeof t.pinnedAt === "string")
      .sort((x, y) => x.pinnedAt!.localeCompare(y.pinnedAt!) || x.id.localeCompare(y.id))
      .map((t) => t.id)
  const waitForServerOrder = async (want: string[]) => {
    let got: string[] = []
    for (let i = 0; i < 40; i++) {
      got = await serverOrder()
      if (got.join() === want.join()) return
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.deepEqual(got, want, "the server holds the band's new order")
  }
  await waitForServerOrder([a, b, c])
  // Alpha is the row the test drags. A click on any row opens its thread in the board's one-thread pane, so
  // "the release did not open it" is a claim that can fail. Done, alpha is in no queue the pane could have
  // brought up on its own. The pin outranks Done: it stays.
  await api.mutate("setThreadState", { slug: a, state: "archived" })

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    const boardUrl = `${baseUrl}/project/${projectSlug}`
    const domOrder = () => page.$$eval("[data-pinned-band] > [data-pinned-row]", (rows) => rows.map((row) => row.getAttribute("data-pinned-row")))
    const box = (slug: string) => page.$eval(`[data-pinned-row="${slug}"]`, (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom, height: r.height }
    })
    const opened = (slug: string) => page.$(`[data-pane-thread] [data-thread-surface="${slug}"]`).then((el) => el !== null)

    await page.goto(boardUrl, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-pane-empty]", { timeout: 15_000 })
    await page.waitForFunction((n) => document.querySelectorAll("[data-pinned-band] > [data-pinned-row]").length === n, { timeout: 15_000 }, 3)
    // gamma's sub-agent row, under it inside the same draggable box.
    await page.waitForFunction((slug) => (document.querySelector(`[data-pinned-row="${slug}"]`)?.getBoundingClientRect().height ?? 0) > 40, { timeout: 15_000 }, c)
    assert.deepEqual(await domOrder(), [a, b, c])
    const [alpha, beta, gamma] = [await box(a), await box(b), await box(c)]
    assert.ok(beta.height > alpha.height + 10, `beta's title wraps, so its row is taller (${beta.height} vs ${alpha.height})`)

    // 1. DRAG alpha below gamma, in small steps the way a hand moves.
    const startY = alpha.top + alpha.height / 2
    await page.mouse.move(alpha.x, startY)
    await page.mouse.down()
    const endY = gamma.bottom - 4
    for (let y = startY; y < endY; y += 6) await page.mouse.move(alpha.x, y)
    await page.mouse.move(alpha.x, endY)
    await new Promise((r) => setTimeout(r, 250)) // let the passed rows' 160ms slide finish
    const midDrag = await page.evaluate((held, passed) => {
      const heldEl = document.querySelector<HTMLElement>(`[data-pinned-row="${held}"]`)!
      return {
        held: heldEl.hasAttribute("data-pin-held"),
        heldTransform: heldEl.style.transform,
        passedTransforms: passed.map((slug: string) => document.querySelector<HTMLElement>(`[data-pinned-row="${slug}"]`)!.style.transform),
        heldBottom: heldEl.getBoundingClientRect().bottom,
      }
    }, a, [b, c])
    assert.equal(midDrag.held, true, "the row is held")
    assert.match(midDrag.heldTransform, /translateY\(\d/, "…and follows the pointer down")
    assert.deepEqual(midDrag.passedTransforms, [`translateY(-${alpha.height}px)`, `translateY(-${alpha.height}px)`], "the rows it passed slid up by its height")
    assert.ok(Math.abs(midDrag.heldBottom - gamma.bottom) < 1, "…and it stops at the band's bottom edge, never over the queue below")
    await page.screenshot({ path: process.env.FRIZZ_PINNED_REORDER_SHOT ?? "/dev/null", clip: { x: 0, y: Math.max(0, alpha.top - 60), width: 620, height: gamma.bottom - alpha.top + 140 } })
    await page.mouse.up()

    assert.deepEqual(await domOrder(), [b, c, a], "the drop is the band's new order at once")
    await waitForServerOrder([b, c, a])
    assert.deepEqual(await domOrder(), [b, c, a], "…and still is once the board carries it back")
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await opened(a), false, "the release did not open the dropped row")
    assert.ok(await page.$("[data-pane-empty]"), "…nor any other: the pane is still empty")
    assert.equal(await page.$$eval("[data-pinned-band] > [data-pinned-row]", (rows) => rows.filter((row) => (row as HTMLElement).style.transform).length), 0, "no row is left displaced")

    // 2. A RELOAD reads the server's order.
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForFunction((n) => document.querySelectorAll("[data-pinned-band] > [data-pinned-row]").length === n, { timeout: 15_000 }, 3)
    assert.deepEqual(await domOrder(), [b, c, a], "the order survived a reload")

    // 3. THE KEYBOARD: Alt+↑ on gamma's focused row moves it to the top, and focus goes with it.
    await page.focus(`[data-pinned-row="${c}"] button`)
    await page.keyboard.down("Alt")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.up("Alt")
    assert.deepEqual(await domOrder(), [c, b, a])
    await waitForServerOrder([c, b, a])
    await page.waitForFunction((slug) => document.activeElement?.closest("[data-pinned-row]")?.getAttribute("data-pinned-row") === slug, { timeout: 2_000 }, c)

    // 4. A PRESS THAT DOES NOT TRAVEL IS STILL A CLICK, and opens alpha in the pane.
    const done = await box(a)
    await page.mouse.click(done.x, done.top + 10)
    await page.waitForSelector(`[data-pane-thread] [data-thread-surface="${a}"]`, { timeout: 10_000 })
    assert.deepEqual(await serverOrder(), [c, b, a], "a click reorders nothing")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
