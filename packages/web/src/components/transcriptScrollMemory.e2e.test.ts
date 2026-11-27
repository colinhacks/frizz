import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

// A READER WHO COMES BACK TO A THREAD FINDS IT WHERE THEY LEFT IT (lib/transcriptScrollMemory), so long as
// nothing has happened in it since: on its tail after "Jump to latest", on the row they had scrolled to,
// with the folds they opened. A thread they never moved in, one that moved while they were away, one whose
// turn is in flight and any thread after a reload still open where lib/openLanding puts them. Until this,
// every switch back re-ran that landing, so a reader who had pressed "Jump to latest" was hauled back up to
// the steer each time they returned.
//
// The threads are seed-open-landing.mjs's, switched between the way the app does it: a click on the pane's
// sidebar row, or the router's own navigation, which keeps the tab and so what it remembers.
//
// Real server, real tailer, real board; the workers are the transcripts the seed writes:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> > /tmp/stack.log 2>&1 &   # its json line names `home`
//   FRIZZ_SCROLL_MEMORY_E2E_URL=http://127.0.0.1:<port> FRIZZ_SCROLL_MEMORY_E2E_HOME=<home> nub run test <this file>
const baseUrl = process.env.FRIZZ_SCROLL_MEMORY_E2E_URL
const home = process.env.FRIZZ_SCROLL_MEMORY_E2E_HOME

interface Reading { fromTail: number; pane: number; topRow: string | null; topRowAt: number | null; steer: number | null; folds: string[] }

test("a thread the reader comes back to opens where they left it, until it moves", { skip: !baseUrl || !home, timeout: 300_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const first = await api.query("board") as { projectDir: string; projectSlug: string }
  const env = { ...process.env }
  delete env.NODE_COMPAT
  const seeded = execFileSync("nub", [new URL("../../../../scripts/seed-open-landing.mjs", import.meta.url).pathname, home!, first.projectDir, "--running"], { env, encoding: "utf8" })
  const daemons: number[] = JSON.parse(seeded.split("\n").find((line) => line.startsWith('{"standInDaemons"')) ?? '{"standInDaemons":[]}').standInDaemons
  const sessionOf = (slug: string) => /\((\S+)\)/.exec(seeded.split("\n").find((line) => line.startsWith(`seeded ${slug} `)) ?? "")?.[1]

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    type Row = { id: string; runtime: string; needsYou?: boolean; lastActivityAt?: string }
    const threads = async () => (await api.query("board") as { threads: Row[] }).threads
    for (let i = 0; i < 120; i++) {
      const all = await threads()
      if (all.find((t) => t.id === "land-running")?.runtime === "running" && all.find((t) => t.id === "land-queued")?.needsYou) break
      await new Promise((r) => setTimeout(r, 250))
    }

    const page = await browser.newPage()
    const desktop = { width: 1440, height: 900, deviceScaleFactor: 1 }
    const phone = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    await page.setViewport(desktop)
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })

    const read = (surface: string) => page.evaluate((sel) => {
      const scroller = document.querySelector<HTMLElement>(`${sel} [data-drawer-transcript-scroll]`)
      if (!scroller) return null
      const top = scroller.getBoundingClientRect().top
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]")]
      const at = rows.find((r) => r.getBoundingClientRect().bottom > top + 1)
      const steer = rows.find((r) => r.innerText.includes("LANDING-STEER"))
      return {
        fromTail: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
        pane: scroller.clientHeight,
        topRow: at?.dataset.transcriptRowKey ?? null,
        topRowAt: at ? Math.round(at.getBoundingClientRect().top - top) : null,
        steer: steer ? Math.round(steer.getBoundingClientRect().top - top) : null,
        folds: rows.flatMap((r) => (r.dataset.transcriptRowKey?.startsWith("fold:") ? [r.dataset.transcriptRowKey] : [])),
      }
    }, surface) as Promise<Reading | null>
    // Where the surface has come to rest: the same reading twice running, once any hold has let go.
    const settled = async (surface: string): Promise<Reading> => {
      await page.waitForSelector(`${surface} [data-transcript-row-key]`, { timeout: 30_000 })
      const since = Date.now()
      let last = ""
      for (;;) {
        const reading = await read(surface)
        const now = JSON.stringify(reading)
        if (reading && now === last && Date.now() - since > 1300) return reading
        last = now
        assert.ok(Date.now() - since < 20_000, `${surface}: the transcript never came to rest`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    const scrollerCentre = (surface: string) => page.evaluate((sel) => {
      const box = document.querySelector<HTMLElement>(`${sel} [data-drawer-transcript-scroll]`)!.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }, surface)
    const wheel = async (surface: string, deltaY: number) => {
      const { x, y } = await scrollerCentre(surface)
      await page.mouse.move(x, y)
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel({ deltaY: deltaY / 6 })
        await new Promise((r) => setTimeout(r, 60))
      }
    }
    // A finger dragged down the pane, which scrolls it up.
    const drag = async (surface: string, dy: number) => {
      const { x, y } = await scrollerCentre(surface)
      await page.touchscreen.touchStart(x, y - dy / 2)
      for (let i = 1; i <= 10; i++) {
        await page.touchscreen.touchMove(x, y - dy / 2 + (dy * i) / 10)
        await new Promise((r) => setTimeout(r, 16))
      }
      await page.touchscreen.touchEnd()
    }
    // The router's own navigation: the tab, and what it remembers, survive it.
    const go = (href: string) => page.evaluate((href) => { history.pushState(null, "", href); dispatchEvent(new PopStateEvent("popstate")) }, href)
    const samePlace = (back: Reading, left: Reading, where: string) => {
      assert.ok(left.fromTail > 200, `${where}: the reader left the thread off its tail (${JSON.stringify(left)})`)
      assert.equal(back.topRow, left.topRow, `${where}: the row at the top of the pane is the one the reader left there`)
      assert.ok(Math.abs((back.topRowAt ?? 0) - (left.topRowAt ?? 0)) <= 2, `${where}: at the height it had, ${left.topRowAt}px, and it is at ${back.topRowAt}px`)
    }
    const onTheLanding = (r: Reading, where: string) => {
      assert.ok(r.steer !== null && r.steer >= 0 && r.steer <= 80, `${where}: the thread opens on its landing, the human's message at the top (${JSON.stringify(r)})`)
      assert.ok(r.fromTail > 200, `${where}: not on its tail`)
    }

    const boardUrl = `${baseUrl}/project/${first.projectSlug}`
    const pane = (slug: string) => `[data-pane-thread] [data-thread-surface="${slug}"]`
    const drawer = (slug: string) => `.frizz-sheet-panel [data-thread-surface="${slug}"]`
    const anywhere = (slug: string) => `[data-thread-surface="${slug}"]`
    const row = (slug: string) => `[data-pane-sidebar] [data-sidebar-item="${slug}"]`
    const away = async () => {
      await page.click(row("land-short"))
      await settled(pane("land-short"))
    }

    await page.goto(boardUrl, { waitUntil: "networkidle2" })
    await page.waitForSelector(row("land-queued"), { timeout: 30_000 })

    // 1. THE PANE. "Jump to latest", another thread, and back: the tail, not the steer again.
    await page.click(row("land-queued"))
    const landed = await settled(pane("land-queued"))
    onTheLanding(landed, "the pane, a queued thread opened")
    await page.click("[data-jump-to-latest]")
    const jumped = await settled(pane("land-queued"))
    assert.ok(jumped.fromTail <= 4, `Jump to latest reached the tail (${jumped.fromTail}px from it)`)
    await away()
    await page.click(row("land-queued"))
    const backAtTail = await settled(pane("land-queued"))
    assert.ok(backAtTail.fromTail <= 4, `the pane: back on the tail the reader jumped to, and it is ${backAtTail.fromTail}px from it`)

    // A thread the reader only looked at still opens on its landing.
    await page.click(row("land-long-steer"))
    const looked = await settled(pane("land-long-steer"))
    await away()
    await page.click(row("land-long-steer"))
    const lookedAgain = await settled(pane("land-long-steer"))
    assert.deepEqual([lookedAgain.topRow, lookedAgain.topRowAt], [looked.topRow, looked.topRowAt], "the pane: a thread the reader never moved in opens on its landing again")

    // Scrolled up mid-thread, away twice, and back each time: the same row at the same height.
    await go(`${boardUrl}?thread=land-snoozed`)
    await settled(pane("land-snoozed"))
    await wheel(pane("land-snoozed"), -1600)
    const midway = await settled(pane("land-snoozed"))
    await away()
    await go(`${boardUrl}?thread=land-snoozed`)
    samePlace(await settled(pane("land-snoozed")), midway, "the pane, back once")
    await page.click(row("land-unsigned"))
    await settled(pane("land-unsigned"))
    await go(`${boardUrl}?thread=land-snoozed`)
    samePlace(await settled(pane("land-snoozed")), midway, "the pane, back again")

    // A fold the reader opened is open when they come back.
    await go(`${boardUrl}?thread=land-done`)
    await settled(pane("land-done"))
    const opened = await page.evaluate((sel) => {
      const scroller = document.querySelector<HTMLElement>(`${sel} [data-drawer-transcript-scroll]`)!
      const box = scroller.getBoundingClientRect()
      const fold = [...scroller.querySelectorAll<HTMLElement>('[data-transcript-row-key^="fold:"]')]
        .find((r) => r.getBoundingClientRect().top >= box.top && r.getBoundingClientRect().bottom <= box.bottom)
      fold?.querySelector("button")?.click()
      return fold?.dataset.transcriptRowKey ?? null
    }, pane("land-done"))
    assert.ok(opened, "the landing has a fold in view to open")
    const unfolded = await settled(pane("land-done"))
    assert.ok(!unfolded.folds.includes(opened), "the fold opened")
    await away()
    await go(`${boardUrl}?thread=land-done`)
    const refolded = await settled(pane("land-done"))
    assert.ok(!refolded.folds.includes(opened), "the pane: the fold the reader opened is still open when they come back")
    samePlace(refolded, unfolded, "the pane, a thread with a fold opened")

    // A thread whose turn is in flight opens on its tail, wherever the reader was in it.
    await go(`${boardUrl}?thread=land-running`)
    await settled(pane("land-running"))
    await wheel(pane("land-running"), -1600)
    const upInFlight = await settled(pane("land-running"))
    assert.ok(upInFlight.fromTail > 200, "the reader scrolled up a running thread")
    await away()
    await go(`${boardUrl}?thread=land-running`)
    const inFlight = await settled(pane("land-running"))
    assert.ok(inFlight.fromTail <= 4, `the pane: a running thread opens on its tail, and it is ${inFlight.fromTail}px from it`)

    // A thread that moves while the reader is away opens on its landing: here, a wake and a new sign-off.
    await away()
    const before = (await threads()).find((t) => t.id === "land-snoozed")?.lastActivityAt
    const sessionId = sessionOf("land-snoozed")!
    const file = path.join(home!, ".claude", "projects", first.projectDir.replace(/[/.]/g, "-"), `${sessionId}.jsonl`)
    const now = Date.now()
    const { wakeDeliveryToken } = await import("@frizz/shared")
    fs.appendFileSync(file, [
      { type: "user", timestamp: new Date(now).toISOString(), sessionId, message: { role: "user", content: `✅ Review approved on acme/app#391.\n\n${wakeDeliveryToken(`scroll-memory-${now}`)}` } },
      { type: "assistant", timestamp: new Date(now + 1000).toISOString(), sessionId, message: { id: `scroll-memory-${now}`, model: "claude-opus-5", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "**Needs you** — LANDING-SIGNOFF-THREE: acme/app#391 is approved.\n\n```awaiting\nprs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Approved\n---\nMerge it when ready.\n```" }] } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n")
    let moved = false
    for (let i = 0; i < 80 && !moved; i++) {
      moved = (await threads()).find((t) => t.id === "land-snoozed")?.lastActivityAt !== before
      if (!moved) await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(moved, "the board has the new sign-off")
    await go(`${boardUrl}?thread=land-snoozed`)
    onTheLanding(await settled(pane("land-snoozed")), "the pane, a thread signed off on while the reader was away")

    // And a reload forgets every place.
    await go(`${boardUrl}?thread=land-queued`)
    assert.ok((await settled(pane("land-queued"))).fromTail <= 4, "the pane: the tail the reader jumped to, before the reload")
    await page.reload({ waitUntil: "networkidle2" })
    onTheLanding(await settled(pane("land-queued")), "the pane, after a reload")

    // 2. A DESKTOP'S DRAWER over a status list, switched to another thread and back.
    await page.goto(`${boardUrl}/status/active?thread=land-done`, { waitUntil: "networkidle2" })
    await settled(drawer("land-done"))
    await wheel(drawer("land-done"), -1600)
    const inDrawer = await settled(drawer("land-done"))
    await go(`${boardUrl}/status/active?thread=land-short`)
    await settled(drawer("land-short"))
    await go(`${boardUrl}/status/active?thread=land-done`)
    samePlace(await settled(drawer("land-done")), inDrawer, "a desktop's drawer")

    // 3. A PHONE, scrolled by a finger: its full-screen page, which a link takes to another thread in place,
    // and its drawer.
    await page.setViewport(phone)
    await page.goto(`${boardUrl}/thread/land-queued`, { waitUntil: "networkidle2" })
    await settled(anywhere("land-queued"))
    await drag(anywhere("land-queued"), 600)
    const onPage = await settled(anywhere("land-queued"))
    // Three times: the page keeps its scroller for the next thread's transcript, and the one leaving it
    // recorded that thread's tail as its own place about half the time until it stopped touching it.
    for (const round of [1, 2, 3]) {
      await go(`${boardUrl}/thread/land-short`)
      await settled(anywhere("land-short"))
      await go(`${boardUrl}/thread/land-queued`)
      samePlace(await settled(anywhere("land-queued")), onPage, `a phone's full-screen page, round ${round}`)
    }
    await page.goto(`${boardUrl}?thread=land-done`, { waitUntil: "networkidle2" })
    await settled(anywhere("land-done"))
    await drag(anywhere("land-done"), 600)
    const inPhoneDrawer = await settled(anywhere("land-done"))
    await go(`${boardUrl}?thread=land-short`)
    await settled(anywhere("land-short"))
    await go(`${boardUrl}?thread=land-done`)
    samePlace(await settled(anywhere("land-done")), inPhoneDrawer, "a phone's drawer")

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
    for (const pid of daemons) {
      try { process.kill(pid) } catch { /* already gone */ }
    }
  }
})
