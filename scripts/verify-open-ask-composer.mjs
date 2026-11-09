// Browser gate for "the queue card keeps its prompt box while an ask is open".
//
// The card used to REPLACE its free-form composer with a lone "Send answers" button whenever the live
// assistant message carried ```question blocks, so the only way out of a card was to answer the question
// the agent chose to ask. Answering is the primary path, not the only one — skipping the options and
// steering with a plain prompt has to stay one keystroke away. This drives the REAL app against a REAL
// disposable stack and proves the whole flow, not the pieces:
//   1. both affordances render on the same card, answer action ABOVE the box (the box owns the bottom edge)
//   2. clicking a question chip does NOT evict the caret from the card's prompt box — the chip-click blur
//      is scoped to that block's own answer textarea, which is a DIFFERENT surface
//   3. a free-text prompt typed into that box actually SENDS (followUp RPC 200) with the question left
//      unanswered, and the card exits through the same dissolve an answer send uses
//   4. desktop + narrow widths, no console/page errors
//
// Seed a stack + an open-ask thread first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-open-ask-composer.mjs --url=http://127.0.0.1:5399 --slug=… [--shots=/tmp/…]
// The run CONSUMES its seed — step 4's steer is a newer user message, which is exactly what retires the
// ```question fence — so re-seed a fresh slug for every run rather than re-pointing it at a spent one.
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { url, slug, shots = "/tmp" } = flags
if (!url || !slug) {
  console.error("usage: node verify-open-ask-composer.mjs --url= --slug= [--shots=/tmp]")
  process.exit(1)
}
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

const SEL = `[data-queue-card-root="${slug}"]`
const BOX = `${SEL} textarea[data-surface="queueComposer"]`
// Scoped to THIS slug's card: the board legitimately holds other queue cards, and a bare
// [data-queue-card-root] silently asserts against whichever one happens to sort first.
const CARD = `(() => {
  const card = document.querySelector('${SEL}')
  if (!card) return null
  const box = card.querySelector('textarea[data-surface="queueComposer"]')
  const answers = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send answers')
  const boxRect = box?.getBoundingClientRect()
  const answersRect = answers?.getBoundingClientRect()
  return {
    slug: card.dataset.queueCardRoot,
    hasBox: Boolean(box),
    placeholder: box?.placeholder ?? null,
    boxValue: box?.value ?? null,
    boxFocused: document.activeElement === box,
    hasAnswers: Boolean(answers),
    answersDisabled: answers?.disabled ?? null,
    // The answer action must sit ABOVE the prompt box: it stays adjacent to the question it answers,
    // and the card's bottom edge is the same prompt box in every state.
    answersAboveBox: Boolean(boxRect && answersRect && answersRect.bottom <= boxRect.top + 1),
    // …and its spacing must stay ASYMMETRIC — tight to the question stack it belongs to, looser to the
    // prompt box below. Symmetric gaps make it read as an appendage of the box, hovering above-right of
    // it rather than hanging off the questions (maintainer 2026-07-22: "the spacing is insane").
    questionToAnswers: (() => {
      const blocks = [...card.querySelectorAll('div')].filter((d) => d.querySelector(':scope > .mt-2 textarea[data-surface="questionAnswer"]'))
      const last = blocks[blocks.length - 1]
      return last && answersRect ? Math.round(answersRect.top - last.getBoundingClientRect().bottom) : null
    })(),
    answersToBox: answersRect && boxRect ? Math.round(boxRect.top - answersRect.bottom) : null,
    boxWidth: boxRect ? Math.round(boxRect.width) : null,
    // A recommended chip's badge precedes its label in source order (the float-right trick), so its
    // textContent reads "RecommendedA. …" — match by substring, never by prefix.
    chips: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /[AB]\\. /.test(t)).length,
    chipSelected: [...card.querySelectorAll('button')].filter((b) => b.className.includes('border-accent')).map((b) => b.textContent.trim().slice(0, 46)),
    answerBoxes: card.querySelectorAll('textarea[data-surface="questionAnswer"]').length,
  }
})()`

const browser = await launchHeadless()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  const rpcs = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("response", (r) => { if (r.url().includes("/rpc/")) rpcs.push({ status: r.status(), route: r.url().split("/rpc/")[1] }) })

  await page.goto(`${url}/`, { waitUntil: "networkidle2", timeout: 30000 })
  await page.waitForSelector(SEL, { timeout: 20000 })
  await settle(1500)

  // ── 1. both affordances coexist ──────────────────────────────────────────────────────────────────
  let s = await page.evaluate(CARD)
  check("the open-ask queue card renders the free-form prompt box", s?.hasBox === true, JSON.stringify(s))
  check("it ALSO renders the Send answers action", s?.hasAnswers === true)
  check("Send answers starts disabled (nothing answered yet)", s?.answersDisabled === true)
  check("Send answers sits ABOVE the prompt box", s?.answersAboveBox === true)
  check("it hangs TIGHT off the question stack", s?.questionToAnswers !== null && s?.questionToAnswers <= 10, `${s?.questionToAnswers}px`)
  check("…and is spaced AWAY from the prompt box below it", (s?.answersToBox ?? 0) >= s?.questionToAnswers * 1.5, `${s?.questionToAnswers}px up vs ${s?.answersToBox}px down`)
  check("the ask's own chips render alongside it", s?.chips === 4, `found ${s?.chips}`)
  check("the ask's answer textareas are a SEPARATE surface from the card box", s?.answerBoxes === 2, `found ${s?.answerBoxes}`)
  check("the placeholder names the escape hatch", /skip the questions/i.test(s?.placeholder ?? ""), s?.placeholder)
  await page.screenshot({ path: `${shots}/card-both-paths-desktop.png` })

  // ── 2. a chip click must not evict the caret from the card's prompt box ───────────────────────────
  await page.focus(BOX)
  await page.type(BOX, "actually, ignore both options — just rerun the suite 50x first", { delay: 5 })
  s = await page.evaluate(CARD)
  check("typing into the card prompt box works while an ask is open", s?.boxValue?.includes("ignore both options") === true, s?.boxValue)
  check("the prompt box holds focus", s?.boxFocused === true)
  const clicked = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll('${SEL} button')].find((b) => b.textContent.includes('A. Key the cache'))
    if (!btn) return false
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    btn.click()
    return true
  })()`)
  check("the question chip is clickable", clicked === true)
  await settle(500)
  s = await page.evaluate(CARD)
  check("the chip actually selected", s?.chipSelected?.some((t) => t.includes("Key the cache")) === true, JSON.stringify(s?.chipSelected))
  check("clicking a chip does NOT blur the card's prompt box", s?.boxFocused === true, `focused=${s?.boxFocused}`)
  check("the typed free text survives the chip click", s?.boxValue?.includes("ignore both options") === true, s?.boxValue)
  check("Send answers enables once a chip is picked", s?.answersDisabled === false)

  // ── 3. narrow width: the two affordances stack, they don't collide ────────────────────────────────
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 })
  await settle(900)
  const narrow = await page.evaluate(CARD)
  check("both affordances survive a narrow viewport", narrow?.hasBox === true && narrow?.hasAnswers === true, JSON.stringify(narrow))
  check("the answer action still sits above the box when narrow", narrow?.answersAboveBox === true)
  check("the prompt box does not overflow the narrow card", (narrow?.boxWidth ?? 0) > 0 && narrow.boxWidth <= 430, `${narrow?.boxWidth}px`)
  await page.screenshot({ path: `${shots}/card-both-paths-narrow.png` })
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  await settle(700)

  // ── 4. the free-text send delivers, question left unanswered, card exits ─────────────────────────
  const before = rpcs.length
  await page.focus(BOX)
  await page.keyboard.press("Enter")
  await settle(3500)
  const sent = rpcs.slice(before)
  check("Enter in the card prompt box fires the followUp RPC", sent.some((r) => r.route === "followUp"), JSON.stringify(sent))
  check("the send RPC succeeded", sent.length > 0 && sent.every((r) => r.status === 200), JSON.stringify(sent))
  const after = await page.evaluate(CARD)
  check("the card exits on the free-text send, same as an answer send", after === null, JSON.stringify(after))
  await page.screenshot({ path: `${shots}/card-after-freetext-send.png` })
  // The steer must land in the THREAD as the user's own message, with the ask never answered. The card
  // is gone from the board by now, so read the thread's own page rather than the (empty) queue.
  await page.goto(`${url}?thread=${slug}`, { waitUntil: "networkidle2", timeout: 30000 })
  await settle(2500)
  const thread = await page.evaluate(`({
    text: document.body.innerText,
    followUpBox: Boolean(document.querySelector('textarea[placeholder*="Follow up"]')),
  })`)
  check("the free-text steer landed in the thread", thread.text.includes("ignore both options"), thread.text.slice(0, 160))
  check("no answer wire was composed — the questions were genuinely skipped", !thread.text.includes("Answers:"))
  check("the thread view still has its own composer", thread.followUpBox === true)
  await page.screenshot({ path: `${shots}/thread-after-freetext-send.png` })

  check("no console/page errors", errors.length === 0, errors.slice(0, 3).join(" | "))
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
