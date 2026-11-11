import assert from "node:assert/strict"
import test from "node:test"

// THE WAIT, DATED, AND THE HOVER (lib/messageTime), on the thread view every surface draws. Skipped
// unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here):
// start `vite` in packages/web and set FRIZZ_REST_GAP_E2E_URL to its origin.
//
// One thread (rest-gap-fixture): a question yesterday, the reply this morning, then a reply four minutes
// after the next rest. So exactly one rest is dated, one keeps "Agent rested", and the trailing one is
// dropped as the tail's restatement. (The queue card, whose transcript walk dropped every rest but the
// dated one, was pinned here too until it went on 2026-11-10.)
const baseUrl = process.env.FRIZZ_REST_GAP_E2E_URL

type Surface = {
  dividers: string[]
  timeBreaks: number
  hovers: Record<string, string | null>
  errors: string[]
}

// The words a reader would rest the pointer on, keyed by what they belong to. The hover is read the way
// the browser finds it: the element under the middle of those words, then the nearest `title` above it.
const HOVER_TARGETS = {
  ask: "Can you check whether the relay token file",
  run: "the fallback is to skip encryption",
  quickReply: "maybe its not worth encrypting",
  datedRest: "10:51",
}

async function read(): Promise<Surface> {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|flushSync/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(new URL("/rest-gap-fixture.html", baseUrl).href, { waitUntil: "networkidle2" })
    await page.waitForFunction(() => document.body.innerText.includes("maybe its not worth encrypting"), { timeout: 15_000 })
    const found = await page.evaluate((targets) => {
      const clean = (text: string) => text.replace(/[\s ]+/g, " ").trim()
      const hoverOver = (words: string) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent?.indexOf(words) ?? -1
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + words.length)
          const box = range.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return hit?.closest("[title]")?.getAttribute("title")?.replace(/ /g, " ") ?? null
        }
        return null
      }
      return {
        // The virtualizer's DOM order is not its visual order.
        dividers: [...document.querySelectorAll<HTMLElement>("[data-wake-divider]")]
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .map((n) => `${n.dataset.wakeDivider}: ${clean(n.innerText)}`),
        timeBreaks: document.querySelectorAll("[data-time-break]").length,
        hovers: Object.fromEntries(Object.entries(targets).map(([key, words]) => [key, hoverOver(words)])),
      }
    }, HOVER_TARGETS)
    return { ...found, errors }
  } finally {
    await browser.close()
  }
}

test("thread view: the late reply's rest reads as its instant, the quick reply's keeps its rule", { skip: !baseUrl }, async () => {
  const thread = await read()
  assert.deepEqual(thread.errors, [], "the thread view logs no error")
  assert.equal(thread.dividers.length, 2, `two rest hairlines, the trailing one dropped: ${thread.dividers.join(" | ")}`)
  assert.equal(thread.dividers[0], "rest-gap: Today · 10:51 AM", "yesterday's rest, answered this morning, reads as the reply's instant")
  assert.match(thread.dividers[1], /^rest: Agent rested · /, "a reply four minutes on keeps the plain rule")
  assert.equal(thread.timeBreaks, 0, "no centred time reading anywhere")

  assert.equal(thread.hovers.ask, "Yesterday at 3:02 PM", "a bubble carries its instant")
  assert.equal(thread.hovers.run, "Today at 10:52 AM", "…and so does the agent's prose after a tool run")
  assert.equal(thread.hovers.quickReply, "Today at 10:56 AM")
  assert.equal(thread.hovers.datedRest, "Agent rested yesterday at 3:03 PM", "the dated hairline's hover names the end of the wait")
})
