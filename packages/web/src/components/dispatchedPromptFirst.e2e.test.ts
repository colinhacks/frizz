import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import test from "node:test"
import type { Page } from "puppeteer"

// A THREAD THE HUMAN STARTS OPENS ON THE WORDS THEY SENT (lib/dispatchedPrompt, maintainer 2026-11-17:
// "Currently, it says 'Session starting' for kind of a long time, when it should be totally trivial for
// you just to show the message that the user just sent at the top, followed by the thinking shimmer").
//
// Driven end to end: the real prompt box dispatches, the real broker starts the worker, the board opens
// the thread (lib/openStartedThread), and the worker writes the prompt to its transcript only after a
// session start of its own (`startms`, the scripted stand-in for Claude Code's hooks and boot). Every
// frame from the Enter on is sampled, and the thread must
//
//   · never say "Session starting…" (nor "Loading…" over an empty column),
//   · draw the words and the Working row from the frame it opens,
//   · keep both exactly where they were when the session's own copy of the words lands,
//   · and never run the Working row's clock backwards: the copy is written seconds after the send, and
//     a clock that re-baselined on it read 3s and then 0s.
//
// Three times: from the first-run form on an empty board, from the sidebar's prompt box beside a thread,
// and from a phone's new-thread page, where the thread opens in a drawer rather than the pane.
//
// The worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_DISPATCHED_PROMPT_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// The project must have no thread yet: the first dispatch is the first-run form's.
// FRIZZ_DISPATCHED_PROMPT_E2E_FRAMES=<file> writes every recorded frame there, as JSON.
const baseUrl = process.env.FRIZZ_DISPATCHED_PROMPT_E2E_URL
const framesFile = process.env.FRIZZ_DISPATCHED_PROMPT_E2E_FRAMES

type Frame = {
  t: number
  open: string | null
  starting: boolean
  loading: boolean
  bubble: { top: number; height: number; landed: boolean } | null
  working: { top: number; text: string } | null
}

/** `send`: the control that sends, or Enter in the box. */
async function recordDispatch(page: Page, box: string, words: string, marker: string, send?: string): Promise<Frame[]> {
  await page.waitForSelector(box)
  await page.click(box)
  await page.type(box, words)
  await page.evaluate((marker) => {
    const w = window as unknown as { __frames: unknown[]; __recording: boolean }
    w.__frames = []
    w.__recording = true
    const t0 = performance.now()
    const round = (n: number) => Math.round(n * 100) / 100
    const tick = () => {
      const surface = document.querySelector<HTMLElement>("[data-thread-surface]")
      const scroller = surface?.querySelector<HTMLElement>("[data-drawer-transcript-scroll]") ?? null
      let bubble: Frame["bubble"] = null
      if (scroller) {
        const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.includes(marker)) continue
          const el = node.parentElement!
          const r = el.getBoundingClientRect()
          bubble = { top: round(r.top), height: round(r.height), landed: !!el.closest("[data-frizz-msg]")?.getAttribute("data-frizz-msg") }
          break
        }
      }
      const workingEl = scroller?.querySelector<HTMLElement>("[data-working-indicator]") ?? null
      const text = scroller?.textContent ?? ""
      w.__frames.push({
        t: round(performance.now() - t0),
        open: surface?.dataset.threadSurface ?? null,
        starting: (document.body.textContent ?? "").includes("Session starting"),
        loading: text.includes("Loading…"),
        bubble,
        working: workingEl ? { top: round(workingEl.getBoundingClientRect().top), text: workingEl.innerText.trim() } : null,
      })
      if (w.__recording) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, marker)
  if (send) await page.click(send)
  else await page.keyboard.press("Enter")
  // Until the worker's reply has replaced the Working row: the whole start, the landing and the turn.
  await page.waitForFunction(() => {
    const frames = (window as unknown as { __frames: Frame[] }).__frames
    const seen = frames.findIndex((f) => f.working !== null)
    return seen >= 0 && frames.slice(seen).some((f) => f.working === null)
  }, { timeout: 30_000, polling: 100 })
  return page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __recording: boolean }
    w.__recording = false
    return w.__frames
  })
}

function assertOptimisticOpen(frames: Frame[], label: string): void {
  assert.deepEqual(frames.filter((f) => f.starting).slice(0, 3), [], `${label}: "Session starting…" was drawn`)
  const openedAt = frames.findIndex((f) => f.open !== null && f.bubble !== null)
  assert.ok(openedAt >= 0, `${label}: the thread opened with the words in it`)
  const opened = frames[openedAt].open
  const shown = frames.slice(openedAt)
  // From the frame it opens, the thread is the new one and the words never leave.
  assert.deepEqual(shown.filter((f) => f.open !== opened || f.bubble === null).slice(0, 3), [], `${label}: a frame drew the thread without the words`)
  assert.deepEqual(shown.filter((f) => f.loading).slice(0, 3), [], `${label}: "Loading…" was drawn over the words`)

  const landedAt = shown.findIndex((f) => f.bubble!.landed)
  assert.ok(landedAt > 0, `${label}: the words were drawn before the session's own copy landed (${landedAt})`)
  const before = shown.slice(0, landedAt)
  const after = shown[landedAt]
  // The stand-in stood for long enough to matter: this is the window that said "Session starting…".
  assert.ok(before.at(-1)!.t - before[0].t > 1500, `${label}: the words stood in for ${before.at(-1)!.t - before[0].t}ms`)
  // …with the Working row under them the whole time.
  assert.deepEqual(before.filter((f) => f.working === null).slice(0, 3), [], `${label}: a frame drew the words with no Working row under them`)
  assert.ok(before.every((f) => f.working!.top > f.bubble!.top), `${label}: the Working row sits under the words`)
  // The landed copy takes the stand-in's place exactly: the bubble and the row under it do not move.
  const last = before.at(-1)!
  assert.deepEqual({ top: after.bubble!.top, height: after.bubble!.height }, { top: last.bubble!.top, height: last.bubble!.height }, `${label}: the words moved when the session's copy landed`)
  assert.equal(after.working?.top, last.working?.top, `${label}: the Working row moved when the session's copy landed`)
  // The clock counts on from the send, through the landing, to the reply.
  const readings = shown.flatMap((f) => (f.working ? [{ t: f.t, s: seconds(f.working.text) }] : []))
  const back = readings.filter((r, i) => i > 0 && r.s < readings[i - 1].s)
  assert.deepEqual(back.slice(0, 3), [], `${label}: the Working clock ran backwards`)
  assert.ok(readings.at(-1)!.s >= 4, `${label}: the clock counted the whole wait (${readings.at(-1)!.s}s)`)
}

/** The Working row's clock, in seconds (`Thinking…\n12s`). */
function seconds(text: string): number {
  const m = /(?:(\d+)m\s*)?(\d+)s\s*$/.exec(text)
  assert.ok(m, `a clock reading: ${JSON.stringify(text)}`)
  return Number(m[1] ?? 0) * 60 + Number(m[2])
}

test("a new thread opens on the words the human sent, with the Working row under them, and nothing moves when they land", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const board = (await api.query("board")) as { projectSlug: string; threads: unknown[] }
  assert.equal(board.threads.length, 0, "the project has no thread yet, so the first dispatch is the first-run form's")

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    await page.goto(`${baseUrl}/project/${board.projectSlug}`, { waitUntil: "networkidle2" })

    // The session takes three seconds to write the prompt down, and its reply two more after that.
    const script = "[script startms=3000 think=2000 ending=bare paras=1]"
    const first = await recordDispatch(page, "textarea", `${script} Audit the resolver cache firstwords`, "firstwords")
    if (framesFile) writeFileSync(framesFile, JSON.stringify({ first }))
    assertOptimisticOpen(first, "first-run form")

    // The board now has a thread, so the prompt box is the sidebar's, and the new thread replaces the open one.
    const second = await recordDispatch(page, "[data-pane-sidebar] textarea", `${script} Check the release notes secondwords`, "secondwords")
    if (framesFile) writeFileSync(framesFile, JSON.stringify({ first, second }))
    assertOptimisticOpen(second, "sidebar prompt box")
    assert.notEqual(second.find((f) => f.bubble)?.open, first.find((f) => f.bubble)?.open, "the second dispatch opened its own thread")

    // A phone: the board's New thread button opens the new-thread page, and the thread opens in a drawer.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await page.goto(`${baseUrl}/project/${board.projectSlug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-mobile-new-thread]")
    await page.click("[data-mobile-new-thread]")
    const phone = await recordDispatch(page, "[data-phone-new-thread] textarea", `${script} Tidy the changelog phonewords`, "phonewords", "[data-phone-start]")
    if (framesFile) writeFileSync(framesFile, JSON.stringify({ first, second, phone }))
    assertOptimisticOpen(phone, "phone new-thread page")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
