import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import test from "node:test"

// INLINE COMMENTS, END TO END (components/TranscriptComments.tsx): a passage of an agent message selected
// with the mouse, commented on through the Comment button and through ⌘I, held as pending across a reload
// and on the thread's other surface, and carried by the next send — read back from the WORKER's own
// transcript, so the wire text is what a real worker would receive, not what the page thinks it sent.
//
// Real server, real broker, real delivery; the worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_TRANSCRIPT_COMMENTS_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// FRIZZ_TRANSCRIPT_COMMENTS_E2E_SHOTS=<dir> also writes the screenshots a visual review reads.
const baseUrl = process.env.FRIZZ_TRANSCRIPT_COMMENTS_E2E_URL
const shots = process.env.FRIZZ_TRANSCRIPT_COMMENTS_E2E_SHOTS

type Page = import("puppeteer").Page

test("a comment on a passage waits as a highlight, survives a reload, and the next send carries it", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const { slug } = await api.mutate("dispatch", { prompt: "[script ending=done paras=4 replyparas=1 think=200 replythink=200] Review the resolver", backend: "claude", model: "haiku", effort: "low" }) as { slug: string }
  let projectSlug = ""
  for (let i = 0; i < 160 && !projectSlug; i++) {
    const board = await api.query("board") as { projectSlug: string; threads: { id: string; runtime: string }[] }
    if (board.threads.find((t) => t.id === slug)?.runtime === "turn-idle") projectSlug = board.projectSlug
    else await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(projectSlug, "the scripted thread came to rest")
  const boardUrl = `${baseUrl}/project/${projectSlug}`
  if (shots) mkdirSync(shots, { recursive: true })

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page: Page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    const surface = `[data-thread-surface="${slug}"]`
    const shot = async (name: string, clip?: { x: number; y: number; width: number; height: number }) => {
      if (shots) await page.screenshot({ path: `${shots}/${name}.png`, ...(clip ? { clip, captureBeyondViewport: false } : {}) })
    }
    const highlights = () => page.evaluate(() => ({
      soft: CSS.highlights.get("frizz-comment")?.size ?? 0,
      active: CSS.highlights.get("frizz-comment-active")?.size ?? 0,
    }))
    const pendingCount = () => page.$eval(`${surface} [data-pending-comments]`, (el) => Number(el.getAttribute("data-pending-comments"))).catch(() => 0)

    // The paragraphs the agent wrote, and where a run of words in one of them sits on the screen.
    const words = (paragraph: number, from: number, to: number) => page.evaluate((sel, p, a, b) => {
      const paras = [...document.querySelectorAll(`${sel} [data-commentable] .md-body p`)]
      const node = [...paras[p].childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 40) as Text
      const text = node.data
      const starts = [...text.matchAll(/\S+/g)].map((m) => m.index!)
      const start = starts[a]
      const endMatch = [...text.matchAll(/\S+/g)][b - 1]
      const end = endMatch.index! + endMatch[0].length
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      const rects = range.getClientRects()
      const first = rects[0]
      const last = rects[rects.length - 1]
      return { quote: text.slice(start, end).replace(/\s+/g, " "), from: { x: first.left + 1, y: first.top + first.height / 2 }, to: { x: last.right - 1, y: last.top + last.height / 2 } }
    }, surface, paragraph, from, to)
    // A real drag, so the browser makes the selection and the pointer that made it comes up.
    const drag = async (at: { from: { x: number; y: number }; to: { x: number; y: number } }) => {
      await page.mouse.move(at.from.x, at.from.y)
      await page.mouse.down()
      await page.mouse.move((at.from.x + at.to.x) / 2, at.to.y, { steps: 4 })
      await page.mouse.move(at.to.x, at.to.y, { steps: 4 })
      await page.mouse.up()
    }

    // 1. THE PANE. A passage of the second paragraph, through the Comment button over the selection.
    await page.goto(`${boardUrl}?thread=${slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${surface} [data-commentable] .md-body p`, { timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 600))
    const first = await words(1, 2, 7)
    await drag(first)
    await page.waitForSelector("[data-comment-button]", { visible: true, timeout: 5000 })
    assert.equal(await page.evaluate(() => window.getSelection()?.toString().replace(/\s+/g, " ").trim()), first.quote, "the drag selected the passage")
    const button = await page.$eval("[data-comment-button]", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    assert.ok(button.y + button.height <= first.from.y, `the Comment button rides above the selection: ${JSON.stringify(button)} vs ${JSON.stringify(first.from)}`)
    await shot("1-comment-button", { x: button.x - 260, y: button.y - 30, width: 620, height: 130 })
    await page.click("[data-comment-button] button")
    await page.waitForSelector("[data-comment-editor] textarea", { visible: true, timeout: 5000 })
    assert.equal(await page.evaluate(() => document.activeElement?.matches("[data-comment-editor] textarea") ?? false), true, "the editor takes the caret")
    assert.equal((await highlights()).active, 1, "the passage being written on is lit")
    await page.keyboard.type("Why key on the name alone here?")
    const editor = await page.$eval("[data-comment-editor]", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    await shot("2-editor", { x: editor.x - 40, y: editor.y - 70, width: editor.width + 80, height: editor.height + 90 })
    await page.keyboard.down("Meta")
    await page.keyboard.press("Enter")
    await page.keyboard.up("Meta")
    await page.waitForSelector("[data-comment-editor]", { hidden: true, timeout: 5000 })
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-pending-comments="1"]`), { timeout: 5000 }, surface)
    assert.deepEqual(await highlights(), { soft: 1, active: 0 }, "the comment waits as a highlight over its passage")
    assert.match(await page.$eval(`${surface} textarea[data-surface="chatComposer"], ${surface} [data-composer-box] textarea`, (el) => (el as HTMLTextAreaElement).placeholder), /note to send with your comment/)

    // Pointing at the passage shows the words; Esc while the editor is open throws an edit away.
    await page.mouse.move(first.from.x + 20, first.from.y)
    await page.waitForSelector("[data-comment-popover]", { visible: true, timeout: 5000 })
    assert.match(await page.$eval("[data-comment-popover]", (el) => el.textContent ?? ""), /Why key on the name alone here\?/)
    const popover = await page.$eval("[data-comment-popover]", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    await shot("3-hover", { x: popover.x - 40, y: popover.y - 70, width: popover.width + 80, height: popover.height + 90 })
    await page.mouse.move(5, 450)
    await page.waitForSelector("[data-comment-popover]", { hidden: true, timeout: 5000 })

    // 2. A second passage, an earlier paragraph, through ⌘I.
    const second = await words(0, 0, 4)
    await drag(second)
    await page.waitForSelector("[data-comment-button]", { visible: true, timeout: 5000 })
    await page.keyboard.down("Meta")
    await page.keyboard.press("KeyI")
    await page.keyboard.up("Meta")
    await page.waitForSelector("[data-comment-editor] textarea", { visible: true, timeout: 5000 })
    await page.keyboard.type("Say what this means for the cache.")
    await page.click("[data-comment-editor] button:last-child")
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-pending-comments="2"]`), { timeout: 5000 }, surface)
    assert.deepEqual(await highlights(), { soft: 2, active: 0 })
    const line = await page.$eval(`${surface} [data-queue-ops-summary]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    await shot("4-count-line", { x: line.x - 10, y: line.y - 10, width: line.width + 20, height: line.height + 110 })
    await shot("4-pane")

    // An empty editor goes with a click elsewhere; Esc cancels one with words in it.
    const third = await words(2, 0, 3)
    await drag(third)
    await page.waitForSelector("[data-comment-button]", { visible: true, timeout: 5000 })
    await page.click("[data-comment-button] button")
    await page.waitForSelector("[data-comment-editor] textarea", { visible: true, timeout: 5000 })
    await page.keyboard.type("never mind")
    await page.keyboard.press("Escape")
    await page.waitForSelector("[data-comment-editor]", { hidden: true, timeout: 5000 })
    assert.equal(await pendingCount(), 2, "Esc added nothing")

    // 3. A RELOAD keeps them, and so does the thread's full-screen page.
    await page.reload({ waitUntil: "networkidle2" })
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-pending-comments="2"]`), { timeout: 15_000 }, surface)
    await page.waitForFunction(() => (CSS.highlights.get("frizz-comment")?.size ?? 0) === 2, { timeout: 10_000 })
    await page.goto(`${boardUrl}/thread/${slug}`, { waitUntil: "networkidle2" })
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-pending-comments="2"]`), { timeout: 15_000 }, surface)
    await page.waitForFunction(() => (CSS.highlights.get("frizz-comment")?.size ?? 0) === 2, { timeout: 10_000 })

    // …and the drawer, where a desktop thread still opens over a status list.
    const drawer = `.frizz-sheet-panel [data-thread-surface="${slug}"]`
    await page.goto(`${boardUrl}/status/active?thread=${slug}`, { waitUntil: "networkidle2" })
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-pending-comments="2"]`), { timeout: 15_000 }, drawer)
    await page.waitForFunction(() => (CSS.highlights.get("frizz-comment")?.size ?? 0) === 2, { timeout: 10_000 })
    await page.goto(`${boardUrl}/thread/${slug}`, { waitUntil: "networkidle2" })
    await page.waitForFunction((sel) => document.querySelector(`${sel} [data-pending-comments="2"]`), { timeout: 15_000 }, surface)
    await page.waitForFunction(() => (CSS.highlights.get("frizz-comment")?.size ?? 0) === 2, { timeout: 10_000 })

    // ↓ walks to a comment and pins its words open.
    await page.click(`${surface} [data-pending-comments] button[aria-label="Next comment"]`)
    await page.waitForSelector("[data-comment-popover]", { visible: true, timeout: 5000 })
    assert.match(await page.$eval("[data-comment-popover]", (el) => el.textContent ?? ""), /Say what this means for the cache\./, "the first in transcript order is the earlier paragraph's")
    await page.keyboard.press("Escape")
    await page.waitForSelector("[data-comment-popover]", { hidden: true, timeout: 5000 })

    // 4. THE SEND carries both, the typed words on top, in transcript order.
    const box = `${surface} [data-composer-box] textarea`
    await page.click(box)
    await page.keyboard.type("Two things before you call it done:")
    await page.keyboard.press("Enter")
    await page.waitForFunction((sel) => !document.querySelector(`${sel} [data-pending-comments]`), { timeout: 10_000 }, surface)
    assert.deepEqual(await highlights(), { soft: 0, active: 0 }, "a sent comment leaves no highlight")
    await page.waitForSelector(`${surface} [data-sent-comments="2"]`, { timeout: 15_000 })
    const wire = await waitForWorkerMessage(api, slug, "Two things before you call it done:")
    assert.equal(
      wire,
      [
        "Two things before you call it done:",
        "",
        "Comments on your earlier messages (2), each under the passage it is about:",
        "",
        `> ${second.quote}`,
        "",
        "Say what this means for the cache.",
        "",
        `> ${first.quote}`,
        "",
        "Why key on the name alone here?",
      ].join("\n"),
      "the worker read the note, then each comment under its passage, in transcript order",
    )
    const bubble = await page.$eval(`${surface} [data-sent-comments="2"]`, (el) => { const r = el.closest("[data-frizz-msg]")!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    await shot("5-sent-bubble", { x: bubble.x - 20, y: bubble.y - 20, width: bubble.width + 40, height: bubble.height + 40 })

    // A quote in the bubble finds its passage again.
    await page.click(`${surface} [data-sent-comments] button`)
    await page.waitForFunction(() => (CSS.highlights.get("frizz-comment-active")?.size ?? 0) === 1, { timeout: 5000 })
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
  }
})

/** The text of the user message the worker's transcript holds, once the send has reached it. */
async function waitForWorkerMessage(api: { query: (name: string, input?: unknown) => Promise<unknown> }, slug: string, opening: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const page = await api.query("threadTranscript", { slug }) as { messages: { role: string; text?: string }[] }
    const found = page.messages.find((m) => m.role === "user" && m.text?.startsWith(opening))
    if (found?.text) return found.text
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("the send never reached the worker's transcript")
}
