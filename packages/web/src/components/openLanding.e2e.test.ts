import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

// A THREAD AT REST OPENS ON THE HUMAN'S LATEST MESSAGE AND THE FIRST SIGN-OFF UNDER IT, NEVER ON ITS TAIL
// (lib/openLanding; maintainer 2026-11-18: "you should not be auto-scrolled to the bottom. You should be
// auto-scrolled to a place where you can see the most recent user steer, and then it shows all of the stuff
// that was collapsed. Then it shows the start of the thread's sign-off messages"). Every surface had its own
// landing until then, each aimed at the NEWEST sign-off or the tail, and since the fold keeps every sign-off
// of a stretch the newest is the last thing in the thread: a queued thread opened 0px from its tail with
// the write-up 555px above the pane, and a desktop's drawer opened on the tail outright.
//
// The seed's long threads all carry five earlier stretches and then the newest: the steer, the worker's
// first words, 40 tool calls behind one hairline, a long sign-off, a wake, a second sign-off and a quiet
// park. This drives each where the board has it — queued, snoozed, done, running — in the pane, in a
// desktop's drawer and on a phone's two surfaces, and opens one of them twice: the second open reads the
// transcript from cache and mounts the scroller in the same commit as the transcript, where a landing that
// needs the scroller in hand finds none and the list's own end-anchoring takes it to the tail.
//
// Real server, real tailer, real board; the workers are the transcripts the seed writes:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> > /tmp/stack.log 2>&1 &   # its json line names `home`
//   FRIZZ_OPEN_LANDING_E2E_URL=http://127.0.0.1:<port> FRIZZ_OPEN_LANDING_E2E_HOME=<home> nub run test <this file>
const baseUrl = process.env.FRIZZ_OPEN_LANDING_E2E_URL
const home = process.env.FRIZZ_OPEN_LANDING_E2E_HOME

const STEER = "LANDING-STEER"
const LEAD = "LANDING-LEAD"
const FIRST = "LANDING-SIGNOFF-ONE"
const SECOND = "LANDING-SIGNOFF-TWO"

interface Band { top: number; bottom: number }
interface Reading { fromTail: number; pane: number; steer: Band | null; lead: Band | null; first: Band | null; second: Band | null }

test("a thread at rest opens on the human's latest message and the first sign-off, on every surface", { skip: !baseUrl || !home, timeout: 300_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const first = await api.query("board") as { projectDir: string; projectSlug: string }
  const env = { ...process.env }
  delete env.NODE_COMPAT
  const seeded = execFileSync("nub", [new URL("../../../../scripts/seed-open-landing.mjs", import.meta.url).pathname, home!, first.projectDir, "--running"], { env, encoding: "utf8" })
  // The running thread's stand-in broker daemon, which is this test's to stop.
  const daemons: number[] = JSON.parse(seeded.split("\n").find((line) => line.startsWith('{"standInDaemons"')) ?? '{"standInDaemons":[]}').standInDaemons

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const want: Record<string, (t: { runtime: string; needsYou?: boolean; archived?: boolean; snoozedUntil?: string | null }) => boolean> = {
      "land-queued": (t) => t.needsYou === true,
      "land-long-steer": (t) => t.needsYou === true,
      "land-short": (t) => t.needsYou === true,
      "land-unsigned": (t) => t.needsYou === true,
      "land-snoozed": (t) => !t.needsYou && !!t.snoozedUntil,
      "land-done": (t) => t.archived === true,
      "land-running": (t) => t.runtime === "running",
    }
    let ready = false
    for (let i = 0; i < 120 && !ready; i++) {
      const board = await api.query("board") as { threads: ({ id: string } & Parameters<(typeof want)[string]>[0])[] }
      ready = Object.entries(want).every(([slug, ok]) => { const t = board.threads.find((x) => x.id === slug); return t !== undefined && ok(t) })
      if (!ready) await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(ready, "the board has each seeded thread where its landing is read: queued, snoozed, done, running")

    const page = await browser.newPage()
    const desktop = { width: 1440, height: 900, deviceScaleFactor: 1 }
    const phone = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    await page.setViewport(desktop)
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })

    const read = (surface: string) => page.evaluate((sel, names) => {
      const scroller = document.querySelector<HTMLElement>(`${sel} [data-drawer-transcript-scroll]`)
      if (!scroller) return null
      const top = scroller.getBoundingClientRect().top
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]")]
      const band = (needle: string) => {
        const row = rows.find((r) => r.innerText.includes(needle))
        if (!row) return null
        const box = row.getBoundingClientRect()
        return { top: Math.round(box.top - top), bottom: Math.round(box.bottom - top) }
      }
      return {
        fromTail: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
        pane: scroller.clientHeight,
        steer: band(names.STEER), lead: band(names.LEAD), first: band(names.FIRST), second: band(names.SECOND),
      }
    }, surface, { STEER, LEAD, FIRST, SECOND }) as Promise<Reading | null>
    // Where the surface has come to rest: the same reading twice running, once the opening hold (900ms)
    // has let go, so a landing that is right at first and hauled to the tail afterwards fails here.
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
    // The human's message at the top, the worker's first words under it, and the first sign-off starting
    // in the upper part of the pane, with the thread's tail well below.
    const readsAsAPair = (r: Reading, where: string) => {
      assert.ok(r.steer && r.lead && r.first, `${where}: the human's message, the worker's first words and the first sign-off are all drawn (${JSON.stringify(r)})`)
      // 0 where the whole transcript is drawn; under "Load earlier messages" in the queue's window.
      assert.ok(r.steer.top >= 0 && r.steer.top <= 80, `${where}: the human's message starts at the top of the pane, and it starts at ${r.steer.top}px`)
      assert.ok(r.lead.top >= r.steer.bottom - 1 && r.first.top > r.lead.top, `${where}: the worker's first words and then the sign-off follow it`)
      assert.ok(r.first.top < r.pane * 0.6, `${where}: the first sign-off starts in the upper part of the pane, at ${r.first.top}px of ${r.pane}`)
      assert.ok(r.second === null || r.second.top > r.first.top, `${where}: it is the FIRST sign-off, the newer one below it`)
      assert.ok(r.fromTail > 200, `${where}: the thread did not open on its tail (${r.fromTail}px from it)`)
    }
    // A steer taller than the pane gives way: the sign-off a quarter of the pane down (160px at most),
    // the end of the steer still showing over it.
    const readsFromTheSignOff = (r: Reading, where: string) => {
      assert.ok(r.steer && r.first, `${where}: the steer and the first sign-off are drawn (${JSON.stringify(r)})`)
      const lead = Math.min(r.pane * 0.25, 160)
      assert.ok(Math.abs(r.first.top - lead) <= 3, `${where}: the first sign-off lands ${Math.round(lead)}px below the top, and it is at ${r.first.top}px`)
      assert.ok(r.steer.top < 0 && r.steer.bottom > 0 && r.steer.bottom < r.first.top, `${where}: the end of the human's message still shows over it`)
    }
    const onItsTail = (r: Reading, where: string) => assert.ok(r.fromTail <= 4, `${where}: a running thread opens on its tail, and it is ${r.fromTail}px from it`)

    const boardUrl = `${baseUrl}/project/${first.projectSlug}`
    const pane = (slug: string) => `[data-pane-thread] [data-thread-surface="${slug}"]`
    const drawer = (slug: string) => `.frizz-sheet-panel [data-thread-surface="${slug}"]`

    // 1. THE PANE, by a click on the thread's row. The first open reads the transcript from the server; the
    // second, after another thread, reads it from cache and mounts its scroller with the transcript.
    await page.goto(boardUrl, { waitUntil: "networkidle2" })
    const row = (slug: string) => `[data-pane-sidebar] [data-sidebar-item="${slug}"]`
    await page.waitForSelector(row("land-queued"), { timeout: 30_000 })
    await page.click(row("land-queued"))
    readsAsAPair(await settled(pane("land-queued")), "the pane, a queued thread opened for the first time")
    await page.click(row("land-short"))
    const short = await settled(pane("land-short"))
    assert.ok(short.steer && short.first && short.steer.top >= 0 && short.first.bottom <= short.pane, "a thread shorter than the pane is drawn whole")
    await page.click(row("land-queued"))
    readsAsAPair(await settled(pane("land-queued")), "the pane, the same thread opened again")
    await page.click(row("land-long-steer"))
    readsFromTheSignOff(await settled(pane("land-long-steer")), "the pane, a steer taller than the pane")
    await page.click(row("land-unsigned"))
    const unsigned = await settled(pane("land-unsigned"))
    assert.ok(unsigned.steer && unsigned.steer.top >= 0 && unsigned.steer.top <= 80 && unsigned.fromTail > 200, `a stretch with no sign-off opens on the human's message (${JSON.stringify(unsigned)})`)

    // …and by its address, for the threads out of the queue, whose whole transcript the pane draws.
    for (const slug of ["land-snoozed", "land-done"]) {
      await page.goto(`${boardUrl}?thread=${slug}`, { waitUntil: "networkidle2" })
      readsAsAPair(await settled(pane(slug)), `the pane, ${slug}`)
    }
    await page.goto(`${boardUrl}?thread=land-running`, { waitUntil: "networkidle2" })
    onItsTail(await settled(pane("land-running")), "the pane")

    // 2. A DESKTOP'S DRAWER, which a thread link opens over a status list. It opened on the tail.
    await page.goto(`${boardUrl}/status/active?thread=land-snoozed`, { waitUntil: "networkidle2" })
    readsAsAPair(await settled(drawer("land-snoozed")), "a desktop's drawer")
    await page.goto(`${boardUrl}/status/active?thread=land-running`, { waitUntil: "networkidle2" })
    onItsTail(await settled(drawer("land-running")), "a desktop's drawer")

    // 3. A PHONE: its full-screen page and its drawer. Both put the NEWEST sign-off's top at the top of
    // the pane until this rule, which on a stretch with two of them is the tail.
    await page.setViewport(phone)
    await page.goto(`${boardUrl}/thread/land-queued`, { waitUntil: "networkidle2" })
    readsAsAPair(await settled(`[data-thread-surface="land-queued"]`), "a phone's full-screen page")
    await page.goto(`${boardUrl}?thread=land-long-steer`, { waitUntil: "networkidle2" })
    readsFromTheSignOff(await settled(`[data-thread-surface="land-long-steer"]`), "a phone's drawer, a steer taller than the pane")
    await page.goto(`${boardUrl}/thread/land-running`, { waitUntil: "networkidle2" })
    onItsTail(await settled(`[data-thread-surface="land-running"]`), "a phone's full-screen page")

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
    for (const pid of daemons) {
      try { process.kill(pid) } catch { /* already gone */ }
    }
  }
})
