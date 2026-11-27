import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

// A THREAD AT REST REMEMBERS WHERE THE READER MOVED IN IT ACROSS THREAD SWITCHES (lib/transcriptScrollMemory).
//
// In both the pane and the drawer, switching from thread A to thread B and back to A restores:
//   1. the tail, when the reader had scrolled or pressed "Jump to latest" on A; and
//   2. the top visible row and its viewport offset, when the reader had scrolled to a mid-thread spot on A.
//
// Real server, real tailer, real board, using the seed from `scripts/seed-open-landing.mjs`:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> > /tmp/stack.log 2>&1 &
//   FRIZZ_SCROLL_MEMORY_E2E_URL=http://127.0.0.1:<port> FRIZZ_SCROLL_MEMORY_E2E_HOME=<home> nub run test <this file>
const baseUrl = process.env.FRIZZ_SCROLL_MEMORY_E2E_URL
const home = process.env.FRIZZ_SCROLL_MEMORY_E2E_HOME

interface AnchorReading {
  fromTail: number
  scrollTop: number
  jumpVisible: boolean
  anchor: { rowKey: string; viewportTop: number } | null
}

test("switching threads and returning preserves both tail attachment and a mid-thread scroll position on the pane and the drawer", { skip: !baseUrl || !home, timeout: 300_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const first = await api.query("board") as { projectDir: string; projectSlug: string }
  const env = { ...process.env }
  delete env.NODE_COMPAT
  execFileSync("nub", [new URL("../../../../scripts/seed-open-landing.mjs", import.meta.url).pathname, home!, first.projectDir], { env, encoding: "utf8" })

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    let ready = false
    for (let i = 0; i < 120 && !ready; i++) {
      const board = await api.query("board") as { threads: { id: string; needsYou?: boolean; snoozedUntil?: string | null }[] }
      const unsigned = board.threads.find((t) => t.id === "land-unsigned")
      const short = board.threads.find((t) => t.id === "land-short")
      const snoozed = board.threads.find((t) => t.id === "land-snoozed")
      ready = Boolean(unsigned?.needsYou && short?.needsYou && snoozed?.snoozedUntil)
      if (!ready) await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(ready, "the board has land-unsigned, land-short and land-snoozed")

    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })

    const read = (surface: string) => page.evaluate((sel) => {
      const scroller = document.querySelector<HTMLElement>(`${sel} [data-drawer-transcript-scroll]`)
      if (!scroller) return null
      const top = scroller.getBoundingClientRect().top
      const firstRow = [...scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]")]
        .find((el) => el.getBoundingClientRect().bottom > top + 1)
      return {
        fromTail: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
        scrollTop: Math.round(scroller.scrollTop),
        jumpVisible: Boolean(document.querySelector(`${sel} [data-jump-to-latest]`)),
        anchor: firstRow?.dataset.transcriptRowKey
          ? { rowKey: firstRow.dataset.transcriptRowKey, viewportTop: Math.round(firstRow.getBoundingClientRect().top - top) }
          : null,
      }
    }, surface) as Promise<AnchorReading | null>

    const settled = async (surface: string): Promise<AnchorReading> => {
      await page.waitForSelector(`${surface} [data-transcript-source-id]`, { timeout: 30_000 })
      const since = Date.now()
      let last = ""
      for (;;) {
        const reading = await read(surface)
        const now = JSON.stringify(reading)
        if (reading && now === last && Date.now() - since > 1100) return reading
        last = now
        assert.ok(Date.now() - since < 20_000, `${surface}: the transcript never came to rest`)
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    const wheelBy = async (surface: string, steps: number, deltaY: number) => {
      const centre = await page.evaluate((sel) => {
        const box = document.querySelector<HTMLElement>(`${sel} [data-drawer-transcript-scroll]`)!.getBoundingClientRect()
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
      }, surface)
      await page.mouse.move(centre.x, centre.y)
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel({ deltaY })
        await new Promise((r) => setTimeout(r, 40))
      }
    }

    const boardUrl = `${baseUrl}/project/${first.projectSlug}`
    const pane = (slug: string) => `[data-pane-thread] [data-thread-surface="${slug}"]`
    const drawer = (slug: string) => `.frizz-sheet-panel [data-thread-surface="${slug}"]`
    const row = (slug: string) => `[data-pane-sidebar] [data-sidebar-item="${slug}"]`

    // 1. THE PANE: cold open lands at the steer, scrolling to the tail and switching A -> B -> A preserves
    // the tail, and wheeling mid-thread and switching A -> B -> A -> B -> A preserves the exact anchor row.
    await page.goto(boardUrl, { waitUntil: "networkidle2" })
    await page.waitForSelector(row("land-unsigned"), { timeout: 30_000 })
    await page.click(row("land-unsigned"))
    const cold = await settled(pane("land-unsigned"))
    assert.ok(cold.fromTail > 200 && cold.jumpVisible, `cold open lands off the tail (${JSON.stringify(cold)})`)

    await wheelBy(pane("land-unsigned"), 20, 400)
    const atTail = await settled(pane("land-unsigned"))
    assert.ok(atTail.fromTail <= 4 && !atTail.jumpVisible, `scrolled to the tail (${JSON.stringify(atTail)})`)

    await page.click(row("land-short"))
    await settled(pane("land-short"))
    await page.click(row("land-unsigned"))
    const restoredTail = await settled(pane("land-unsigned"))
    assert.ok(restoredTail.fromTail <= 4 && !restoredTail.jumpVisible, `switching A -> B -> A preserves tail attachment (${JSON.stringify(restoredTail)})`)

    await wheelBy(pane("land-unsigned"), 5, -240)
    const midPane = await settled(pane("land-unsigned"))
    assert.ok(midPane.fromTail > 200 && midPane.anchor, `wheeled to a mid-thread anchor (${JSON.stringify(midPane)})`)

    for (const round of [1, 2]) {
      await page.click(row("land-short"))
      await settled(pane("land-short"))
      await page.click(row("land-unsigned"))
      const restoredMid = await settled(pane("land-unsigned"))
      assert.equal(restoredMid.anchor?.rowKey, midPane.anchor!.rowKey, `pane round ${round}: same top visible row`)
      assert.ok(Math.abs((restoredMid.anchor?.viewportTop ?? 0) - midPane.anchor!.viewportTop) <= 2, `pane round ${round}: same viewport offset (${restoredMid.anchor?.viewportTop} vs ${midPane.anchor!.viewportTop})`)
    }

    // 2. A DESKTOP DRAWER: wheeling to a mid-thread spot, closing/switching the drawer and reopening it
    // restores the same row and viewport offset.
    await page.goto(`${boardUrl}/status/active?thread=land-snoozed`, { waitUntil: "networkidle2" })
    const coldDrawer = await settled(drawer("land-snoozed"))
    assert.ok(coldDrawer.fromTail > 200, `drawer cold open lands off the tail (${JSON.stringify(coldDrawer)})`)
    await wheelBy(drawer("land-snoozed"), 4, 220)
    const midDrawer = await settled(drawer("land-snoozed"))
    assert.ok(midDrawer.anchor && midDrawer.scrollTop > coldDrawer.scrollTop + 200, `wheeled down in the drawer (${JSON.stringify(midDrawer)})`)

    await page.keyboard.press("Escape")
    await page.waitForFunction((sel) => !document.querySelector(sel), {}, drawer("land-snoozed"))
    await page.click(`[data-status-row="land-snoozed"]`)
    const restoredDrawer = await settled(drawer("land-snoozed"))
    assert.equal(restoredDrawer.anchor?.rowKey, midDrawer.anchor!.rowKey, "reopening the drawer restores the same top visible row")
    assert.ok(Math.abs((restoredDrawer.anchor?.viewportTop ?? 0) - midDrawer.anchor!.viewportTop) <= 2, `reopening the drawer restores the same viewport offset (${restoredDrawer.anchor?.viewportTop} vs ${midDrawer.anchor!.viewportTop})`)

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
  }
})
