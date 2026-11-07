import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

// THE QUEUE GOES OUT ONE MESSAGE PER TURN (maintainer 2026-10-20: "Items in the queue should always DQ
// one at a time"). Messages sent with "Send to queue" while the agent works reach it one per turn: the
// next goes out only once it has rested after the one before. Driven end to end: the real thread page
// ticks the row and sends three messages through the prompt box, the real server holds and releases them,
// the real broker hands each to the worker, and the worker's own transcript is the judge — each message
// must be read in a turn that began after the previous one's turn ended. A second thread is the negative
// control: three ordinary steers sent mid-turn, which land in ONE turn, so the transcript check can fail.
//
// The tick is STICKY and the same in every tab (maintainer 2026-10-20, lib/sendMode.ts): it is still on
// once the queue has drained and the agent has rested, a second tab opens on it in another thread, and
// a pick there reaches the first tab without a reload and outlives one.
//
// The worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_QUEUE_ONE_AT_A_TIME_E2E_URL=http://127.0.0.1:<port> FRIZZ_QUEUE_ONE_AT_A_TIME_E2E_HOME=<the stack's "home"> \
//     nub run test <this file>
// FRIZZ_QUEUE_ONE_AT_A_TIME_E2E_SHOTS=<dir> keeps three screenshots: the menu, the queued run, the drained thread.
const baseUrl = process.env.FRIZZ_QUEUE_ONE_AT_A_TIME_E2E_URL
const home = process.env.FRIZZ_QUEUE_ONE_AT_A_TIME_E2E_HOME
const shots = process.env.FRIZZ_QUEUE_ONE_AT_A_TIME_E2E_SHOTS

type Board = { projectSlug: string; threads: { id: string; runtime: string; sessionId?: string }[] }

// The worker's transcript, as line indexes: where each marked message was READ (a user record, or the
// attachment a mid-turn hand-over writes — never the enqueue, which only says it arrived) and where each
// turn ended.
function readTranscript(sessionId: string): { readAt: (marker: string) => number; turnEnds: number[] } {
  const projects = join(home!, ".claude", "projects")
  const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)))
  assert.ok(dir, `the worker's transcript for ${sessionId} exists`)
  const lines = readFileSync(join(projects, dir, `${sessionId}.jsonl`), "utf8").split("\n").filter(Boolean)
  const records = lines.map((line) => ({ line, rec: JSON.parse(line) as { type?: string; message?: { stop_reason?: string } } }))
  const turnEnds = records.flatMap(({ rec }, i) => (rec.type === "assistant" && rec.message?.stop_reason === "end_turn" ? [i] : []))
  const readAt = (marker: string) => records.findIndex(({ line, rec }) => (rec.type === "user" || rec.type === "attachment") && line.includes(marker))
  return { readAt, turnEnds }
}
const endAfter = (turnEnds: number[], index: number) => turnEnds.find((e) => e > index) ?? Infinity

test("messages sent to the queue from the prompt box reach the worker one turn each", { skip: !baseUrl || !home, timeout: 300_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  // A first turn long enough to queue into (eight 2.5s tool calls), and reply turns with tool calls in
  // them, so a message handed over mid-turn has a boundary to be handed over at.
  const script = "[script ending=done paras=1 tools=8 toolms=2500 replytools=2 replyparas=1 replythink=500]"
  const dispatch = (prompt: string) => api.mutate("dispatch", { prompt, backend: "claude", model: "haiku", effort: "low" }) as Promise<{ slug: string; sessionId: string }>
  const one = await dispatch(`${script} Queue one at a time`)
  const control = await dispatch(`${script} Steers`)
  const board = async () => (await api.query("board")) as Board
  const runtime = async (slug: string) => (await board()).threads.find((t) => t.id === slug)?.runtime
  let projectSlug = ""
  for (let i = 0; i < 120 && !projectSlug; i++) {
    const b = await board()
    const r = (id: string) => b.threads.find((t) => t.id === id)?.runtime
    if (r(one.slug) === "running" && r(control.slug) === "running") projectSlug = b.projectSlug
    else await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(projectSlug, "both scripted threads are working")

  if (shots) mkdirSync(shots, { recursive: true })
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    const sends: Record<string, unknown>[] = []
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/rpc/followUp")) sends.push(JSON.parse(r.postData() ?? "{}"))
    })
    const full = `main[data-standalone-thread] [data-thread-surface="${one.slug}"]`
    await page.goto(`${baseUrl}/project/${projectSlug}/thread/${one.slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${full} [data-composer-box] textarea`)
    const split = `${full} [data-send-split]`
    const modeNow = () => page.$eval(split, (el) => el.getAttribute("data-send-mode"))
    assert.equal(await modeNow(), "steer", "a thread's prompt box starts on steer")

    // 1. THE MENU's queue row says how the queue goes out, and ticking it is what the button and the
    //    placeholder say.
    await page.click(`${full} [data-send-menu]`)
    await page.waitForSelector(`[data-send-modes] [data-send-mode-row="queue"]`)
    const rows = await page.$$eval("[data-send-modes] [data-send-mode-row]", (els) => els.map((el) => ({ mode: el.getAttribute("data-send-mode-row"), text: el.textContent })))
    assert.deepEqual(rows.map((r) => r.mode), ["steer", "queue"])
    assert.match(rows[1].text ?? "", /Send to queue.*Each queued message gets a turn of its own\./)
    await page.click(`[data-send-modes] [data-send-mode-row="queue"]`)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-send-mode") === "queue", { timeout: 5000 }, split)
    if (shots) {
      // Opened again, to show the tick.
      await page.click(`${full} [data-send-menu]`)
      await page.waitForSelector(`[data-send-modes] [data-send-mode-row="queue"]`)
      await page.screenshot({ path: join(shots, "1-send-menu.png"), clip: await menuClip(page, full) })
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => !document.querySelector("[data-send-modes]"), { timeout: 5000 })
    }
    assert.equal(await page.$eval(`${full} [data-composer-box] textarea`, (el) => el.getAttribute("placeholder")), "Queue a message for when the agent rests…")

    // 2. THREE MESSAGES from the prompt box, while the first turn runs.
    assert.equal(await runtime(one.slug), "running", "still mid-turn when the messages are sent")
    for (const n of [1, 2, 3]) {
      await page.type(`${full} [data-composer-box] textarea`, `ONE-${n} message ${n}`)
      await page.keyboard.press("Enter")
      await page.waitForFunction((sel, n) => document.querySelectorAll(sel).length >= n, { timeout: 10_000 }, `${full} [data-frizz-msg^="delivery:"]`, n)
    }
    for (let i = 0; i < 40 && sends.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 250))
    assert.deepEqual(sends.map((s) => s.hold), [true, true, true], "each send asked to be held for the rest")
    const sendNow = `${full} [data-queued-send-now] [data-send-now]`
    await page.waitForSelector(sendNow)
    assert.match(await page.$eval(sendNow, (el) => el.getAttribute("title") ?? ""), /^Send the next one now/, "Send now says it hands over the next one")
    if (shots) await page.screenshot({ path: join(shots, "2-held-run.png") })

    // THE CONTROL: three ordinary steers into the other thread's running turn.
    for (const n of [1, 2, 3]) {
      await api.mutate("followUp", { slug: control.slug, sessionId: control.sessionId, message: `CTRL-${n} steer`, deliveryId: `ctrl-${n}-${Date.now()}` })
    }

    // 3. THE QUEUE DRAINS one rest at a time. Between the first rest and the last, the tick holds:
    //    a message typed in that window must queue, not steer into the turn answering the first.
    const deadline = Date.now() + 180_000
    let sawModeHeldAcrossRest = false
    for (;;) {
      const t = readTranscript(one.sessionId)
      const reads = [1, 2, 3].map((n) => t.readAt(`ONE-${n} `))
      if (reads[0] >= 0 && reads[2] < 0 && (await modeNow()) === "queue") sawModeHeldAcrossRest = true
      if (reads[2] >= 0 && endAfter(t.turnEnds, reads[2]) !== Infinity && (await runtime(one.slug)) === "turn-idle") break
      assert.ok(Date.now() < deadline, `the queue drained within 3m (read so far: ${JSON.stringify(reads)})`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const t = readTranscript(one.sessionId)
    const [u1, u2, u3] = [1, 2, 3].map((n) => t.readAt(`ONE-${n} `))
    assert.ok(u1 >= 0 && u1 < u2 && u2 < u3, `read in order: ${u1}, ${u2}, ${u3}`)
    assert.ok(endAfter(t.turnEnds, u1) < u2, `ONE-2 was read after ONE-1's turn ended (ONE-1 at ${u1}, its end at ${endAfter(t.turnEnds, u1)}, ONE-2 at ${u2})`)
    assert.ok(endAfter(t.turnEnds, u2) < u3, `ONE-3 was read after ONE-2's turn ended (ONE-2 at ${u2}, its end at ${endAfter(t.turnEnds, u2)}, ONE-3 at ${u3})`)
    assert.ok(sawModeHeldAcrossRest, "the Send menu stayed on the queue while it drained")
    // Rested with nothing held: the tick stays where the operator put it.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(await modeNow(), "queue", "the Send menu is still on the queue after the agent rests")
    if (shots) await page.screenshot({ path: join(shots, "3-drained.png") })

    // 4. EVERY TAB. A second tab, on the other thread, opens on the queue; a pick there reaches this tab
    //    live, and a reload keeps it.
    const other = await browser.newPage()
    await other.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 })
    other.on("pageerror", (e) => errors.push(String(e)))
    const otherFull = `main[data-standalone-thread] [data-thread-surface="${control.slug}"]`
    await other.goto(`${baseUrl}/project/${projectSlug}/thread/${control.slug}`, { waitUntil: "networkidle2" })
    await other.waitForSelector(`${otherFull} [data-send-split]`)
    assert.equal(await other.$eval(`${otherFull} [data-send-split]`, (el) => el.getAttribute("data-send-mode")), "queue", "another tab, on another thread, opens on the queue")
    await other.click(`${otherFull} [data-send-menu]`)
    await other.waitForSelector(`[data-send-modes] [data-send-mode-row="steer"]`)
    if (shots) await other.screenshot({ path: join(shots, "4-other-tab-menu.png"), clip: await menuClip(other, otherFull) })
    await other.click(`[data-send-modes] [data-send-mode-row="steer"]`)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-send-mode") === "steer", { timeout: 5000 }, split)
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForSelector(split)
    assert.equal(await modeNow(), "steer", "the pick outlives a reload")
    await other.close()

    // 5. THE CONTROL: the steers share one turn — which is what makes the check above able to fail.
    for (;;) {
      const c = readTranscript(control.sessionId)
      const reads = [1, 2, 3].map((n) => c.readAt(`CTRL-${n} `))
      if (reads.every((r) => r >= 0) && (await runtime(control.slug)) === "turn-idle") {
        assert.ok(endAfter(c.turnEnds, reads[0]) > reads[1], `the control's CTRL-2 was read inside CTRL-1's turn (${JSON.stringify(reads)}, ends ${JSON.stringify(c.turnEnds)})`)
        break
      }
      assert.ok(Date.now() < deadline, `the control drained (read so far: ${JSON.stringify(reads)})`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
  }
})

// The prompt box with its open menu above it, for the screenshot.
async function menuClip(page: import("puppeteer").Page, surface: string) {
  return page.evaluate((sel) => {
    const box = document.querySelector(`${sel} [data-composer-box]`)!.getBoundingClientRect()
    const menu = document.querySelector("[data-send-modes]")!.getBoundingClientRect()
    const top = Math.min(box.top, menu.top) - 16
    const left = Math.min(box.left, menu.left) - 16
    return { x: left, y: top, width: Math.max(box.right, menu.right) + 16 - left, height: Math.max(box.bottom, menu.bottom) + 16 - top }
  }, surface)
}
