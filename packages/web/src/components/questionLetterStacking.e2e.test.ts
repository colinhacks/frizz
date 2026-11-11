import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// A question's free-text row wears its option letter laid over the box, and that letter has to clear the
// box and nothing else. It carried `z-10` until 2026-11-06, the same z as the thread's sticky header and
// later in the DOM, so as the card scrolled, the one letter stayed lit across the header ("E." over
// "Last active 5h ago"). Asked of a real browser, because paint order is the thing under test, on each of
// the thread's three surfaces: the desktop board's one-thread pane (which replaced the queue card on
// 2026-11-09), a drawer, and the full-screen page. A desktop board opens every thread in its pane, so the
// drawer is opened over a status list (`/status/<status>?thread=<slug>`), the board view with no pane.
//
// Real server and broker, scripted worker, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_QUESTION_LETTER_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// The stack's workers are detached daemons that outlive it, so kill them by PID with the stack.
const baseUrl = process.env.FRIZZ_QUESTION_LETTER_E2E_URL

const FENCE = [
  "```question",
  "id: letter-under-header",
  "kind: choice",
  "question: Which gateway should carry the traffic?",
  "options:",
  "  - label: The HTTP one",
  "  - label: The gRPC one",
  "```",
].join("\n")

// The card sits mid-message with prose after it, so there is room to scroll its last row up to the header.
const REST = ["Two gateways are in play.", FENCE, ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} after the question, to scroll past.`)].join("\n\n")

type Reading = { letter: string; onBox: boolean; underHeader: boolean; hit: string }

// In the page. Reads what paints at the letter's centre twice: at rest over its box, then scrolled so the
// letter sits on the surface's sticky header. Every element is made hittable while reading, since the
// letter is click-through and `elementFromPoint` would otherwise skip it and pass whatever it hides.
async function read(surfaceSelector: string): Promise<Reading> {
  const surface = document.querySelector(surfaceSelector)
  const box = surface?.querySelector('textarea[data-surface="questionAnswer"]') as HTMLElement | null
  const letter = box?.previousElementSibling as HTMLElement | null
  if (!surface || !box || !letter) throw new Error(`no free-text row in ${surfaceSelector}`)
  const header = (surface.querySelector("[data-thread-header]")
    ?? [...surface.querySelectorAll<HTMLElement>("*")].find((el) => getComputedStyle(el).position === "sticky")) as HTMLElement | undefined
  if (!header) throw new Error(`no sticky header in ${surfaceSelector}`)
  let scroller: HTMLElement | null = box.parentElement
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
  // A surface that scrolls the document itself reads `visible` for its overflow.
  scroller ??= document.scrollingElement as HTMLElement

  const force = document.createElement("style")
  force.textContent = "*, *::before, *::after { pointer-events: auto !important }"
  document.head.append(force)
  try {
    const centre = () => {
      const r = letter.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const topAt = ({ x, y }: { x: number; y: number }) => document.elementFromPoint(x, y)
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    // Pin the header first, since only a pinned header stays put while the row moves up to it. Then the
    // row in the open, its box painted under the letter.
    surface.scrollIntoView({ block: "start" })
    await settle()
    scroller.scrollTop += centre().y - header.getBoundingClientRect().bottom - 60
    await settle()
    const onBox = letter.contains(topAt(centre()))

    const h = header.getBoundingClientRect()
    scroller.scrollTop += centre().y - (h.top + h.height / 2)
    await settle()
    const at = centre()
    const now = header.getBoundingClientRect()
    if (at.y < now.top || at.y > now.bottom) {
      const where = `scroller ${scroller.tagName.toLowerCase()}.${String(scroller.className).split(" ").slice(0, 3).join(".")} at ${scroller.scrollTop} of ${scroller.scrollHeight - scroller.clientHeight}`
      throw new Error(`the letter at y=${at.y} never reached the header (${now.top}–${now.bottom}) in ${surfaceSelector}, ${where}`)
    }
    const hit = topAt(at)
    return {
      letter: letter.textContent ?? "",
      onBox,
      underHeader: !!hit && header.contains(hit),
      hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ").slice(0, 3).join(".")}` : "nothing",
    }
  } finally {
    force.remove()
  }
}

test("a question's free-text letter sits over its box and under the thread's sticky header, on every surface", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "question-letter-stacking-"))
  const turns = join(dir, "turns.json")
  writeFileSync(turns, JSON.stringify({ turns: [{ text: REST }] }))
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const dispatch = (prompt: string) => api.mutate("dispatch", { prompt, backend: "claude", model: "haiku", effort: "low" }) as Promise<{ slug: string; sessionId: string }>
  const { slug: queued } = await dispatch(`[script file=${turns}] Ask about the gateway`)
  const { slug: snoozed, sessionId: snoozedSession } = await dispatch(`[script file=${turns}] Ask about the gateway again`)
  let projectSlug = ""
  for (let i = 0; i < 120 && !projectSlug; i++) {
    const board = await api.query("board") as { projectSlug: string; threads: { id: string; runtime: string }[] }
    if ([queued, snoozed].every((id) => board.threads.find((t) => t.id === id)?.runtime === "turn-idle")) projectSlug = board.projectSlug
    else await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(projectSlug, "both scripted threads came to rest")
  // One thread queued for the pane and the /full page, one snoozed for the drawer, as the board would hold them.
  await api.mutate("setThreadSnooze", { slug: snoozed, sessionId: snoozedSession, until: new Date(Date.now() + 3_600_000).toISOString() })
  const boardUrl = `${baseUrl}/project/${projectSlug}`

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 60_000 })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 })
    // The pane remembers full screen and a hidden rail across loads; start from its default layout.
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    const surfaces = {
      pane: { url: `${boardUrl}?thread=${queued}`, selector: `[data-pane-thread] [data-thread-surface="${queued}"]` },
      drawer: { url: `${boardUrl}/status/active?thread=${snoozed}`, selector: `.frizz-sheet-panel [data-thread-surface="${snoozed}"]` },
      full: { url: `${boardUrl}/thread/${queued}`, selector: `main[data-standalone-thread] [data-thread-surface="${queued}"]` },
    }
    for (const [name, { url, selector }] of Object.entries(surfaces)) {
      await page.goto(url, { waitUntil: "networkidle2" })
      const box = await page.waitForSelector(`${selector} textarea[data-surface="questionAnswer"]`, { timeout: 30_000 })
      // Scroll as a READER first. A thread that opens at the top of its window (the pane's queued
      // thread, ChatView `openAtTop`) holds it there against programmatic scrolls until a reader's own
      // gesture claims the transcript, so `read` setting scrollTop alone was undone about half the time.
      const at = (await box!.boundingBox())!
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
      await page.mouse.wheel({ deltaY: 40 })
      const reading = await page.evaluate(read, selector)
      assert.equal(reading.letter, "C.", `${name}: the free-text row takes the letter after the two options`)
      assert.ok(reading.onBox, `${name}: the letter paints over its own box`)
      assert.ok(reading.underHeader, `${name}: the sticky header covers the letter scrolled under it, and ${reading.hit} was on top`)
    }
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
