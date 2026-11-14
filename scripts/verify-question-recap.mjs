#!/usr/bin/env node
// VERIFY: a recap the worker writes after a WAKE, before the human's next turn, draws each open question
// LIVE beside the write-up that set it up, and the two cards share one answer (lib/questionShadow
// placeQuestions, 2026-11-10). After a turn the human puts in, every naming still draws it live (2026-11-14:
// until then an older naming drew a read-only copy there).
//
// The report it reproduces: a write-up with six questions interleaved in its prose; another thread's steer
// woke the worker; it rested again on a two-line note re-listing all six as `id:` references; all six
// cards left the write-up for the foot of the note, and the write-up drew read-only copies in their slots.
//
// The worker is scripts/scripted-claude.mjs behind the REAL broker. Its questions are registered by the
// server from its own fences, and the wake is a real `frizzctl timer` fired by the real scheduler — a
// machine wake, as the steer was. Three turns:
//
//   1. the write-up: lead-in, alpha, lead-in, beta, closing prose — and a 10s timer
//   2. woken by the timer: "Both are still open:" and two `id:` references
//   3. after the human types "Move alpha": one reference to alpha
//
// Then it reads every question card in document order, with the message each sits in:
//
//   after 2: write-up alpha live, beta live; recap alpha live, beta live
//   a pick on the recap's beta shows on the write-up's beta; Enter in the prompt box answers it once
//   after 3: write-up alpha live, beta answered copy; recap alpha live, beta answered; turn 3 alpha live
//
// Boot a stack with the scheduler armed and the scripted worker, from a shell with no Frizz worker
// variables, on a throwaway repo:
//
//   mkdir -p /tmp/qr-project && git -C /tmp/qr-project init -q
//   env -u FRIZZ_STATE_DIR -u FRIZZ_SERVER_LOCK -u FRIZZ_PROJECT_ID -u FRIZZ_NODE -u FRIZZ_THREAD \
//     -u FRIZZ_PERM_DIR -u FRIZZ_NATIVE_ASK nub scripts/adhoc-stack.mjs --port=47661 --wakers \
//     --project=/tmp/qr-project --claude-bin=$PWD/scripts/scripted-claude.mjs > /tmp/qr-stack.log 2>&1 &
//
// then, with its json line's port and slug:
//
//   nub scripts/verify-question-recap.mjs --port=47661 --slug=<project slug> [--shots=/abs/dir]
//
// Kill the stack by its pid afterwards, and the scripted worker's broker daemon with it.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")))
if (!flags.port || !flags.slug) {
  console.error("usage: nub scripts/verify-question-recap.mjs --port=N --slug=<project slug> [--shots=/abs/dir]")
  process.exit(1)
}
const base = `http://127.0.0.1:${flags.port}`
const api = createRpcClient(`${base}/`, flags.slug)
if (!(await api.waitForHealth(30_000))) throw new Error(`no stack answers on ${base}`)

const ask = (id, question, a, b) => [
  "```question", `id: ${id}`, "kind: choice", `question: ${question}`, "options:",
  `  - label: ${a}`, "    recommended: true", `  - label: ${b}`, "```",
].join("\n")
const ref = (id) => ["```question", `id: ${id}`, "```"].join("\n")
const TIMER_TRAILER = "(One-off timer, set for"

const dir = mkdtempSync(join(tmpdir(), "question-recap-"))
const turns = join(dir, "turns.json")
writeFileSync(turns, JSON.stringify({
  think: 200,
  turns: [
    { name: "write-up", on: "Start",
      tools: [{ command: "frizzctl timer set --in-seconds 10 --prompt 'Check the nightly build' --description 'Check the nightly build'", description: "Setting a timer" }],
      text: [
        "Two calls are left before the settings work lands.",
        "Alpha lead-in: the store decides how settings survive a crash mid-write.",
        ask("alpha", "Which alpha should ship?", "Alpha one", "Alpha two"),
        "Beta lead-in: the cache only matters once a board has thousands of threads.",
        ask("beta", "Which beta should ship?", "Beta one", "Beta two"),
        "Closing prose: everything else is done and committed.",
      ].join("\n\n") },
    { name: "recap", on: TIMER_TRAILER, text: [
      "The nightly build is green, and nothing else has changed. Both are still open:", ref("alpha"), ref("beta"),
    ].join("\n\n") },
    { name: "moves", on: "Move alpha", text: ["Alpha again, now that you have replied:", ref("alpha")].join("\n\n") },
    { name: "noted", times: 0, text: "Noted." },
  ],
}))

const until = async (what, read, ms = 60_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}
const threadOf = async (slug) => (await api.query("board")).threads.find((t) => t.id === slug)
const openIds = async (slug) => ((await threadOf(slug))?.questions ?? []).map((q) => q.spec.handle).sort().join(" ")
const said = async (slug, text) => {
  const page = await api.query("threadTranscript", { slug })
  return (page.messages ?? []).some((m) => m.role === "assistant" && m.text?.includes(text))
}

const step = (what) => console.log(`${new Date().toISOString().slice(11, 19)}  ${what}`)
const { slug, sessionId } = await api.mutate("dispatch", { prompt: `[script file=${turns}] Start`, backend: "claude", title: "Question recap" })
step(`dispatched ${slug}`)
await until("both questions to register", async () => (await openIds(slug)) === "alpha beta")
step("alpha and beta registered")
await until("the timer-woken recap", () => said(slug, "Both are still open:"), 90_000)
step("the timer woke the worker, and it wrote the recap")
// A card is answerable once the turn that drew it has ended; a pick made while it is still running is refused.
await until("the recap's turn to end", async () => !["running", "spawning"].includes((await threadOf(slug))?.runtime), 60_000)
step(`the thread is at rest (${(await threadOf(slug))?.runtime})`)

// Every question card inside `root`, in document order: which question, what it is, and which message it
// sits in (the index among the distinct transcript rows holding a card), plus whether each lead-in sits
// directly above its live card.
const readCards = (page, root) => page.evaluate((root) => {
  const scope = document.querySelector(root)
  if (!scope) return null
  const cards = [...scope.querySelectorAll("article[data-question-id], article[data-question-copy]")]
  const rows = []
  const out = cards.map((el) => {
    const row = el.closest("[data-transcript-source-id]")
    const key = row?.getAttribute("data-transcript-source-id") ?? "?"
    if (!rows.includes(key)) rows.push(key)
    const which = /Which (\w+) should ship\?/.exec(el.textContent ?? "")?.[1] ?? "?"
    // A copy is only ever of a question that is no longer open: an open one draws live at every naming.
    const what = el.hasAttribute("data-question-copy")
      ? (el.hasAttribute("data-settled-question") ? "answered copy" : "copy")
      : el.hasAttribute("data-settled-question") ? "answered" : "live"
    return { which, what, row: rows.indexOf(key) }
  })
  // The lead-in each live card is meant to sit under, and nothing but prose between them.
  const textNode = (needle) => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes(needle)) return n
    return null
  }
  const before = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  const live = (w) => cards.find((el) => !el.hasAttribute("data-question-copy") && el.textContent.includes(`Which ${w} should ship?`))
  const order = {
    alphaUnderItsLeadIn: before(textNode("Alpha lead-in"), live("alpha")) && before(live("alpha"), textNode("Beta lead-in")),
    betaUnderItsLeadIn: before(textNode("Beta lead-in"), live("beta")) && before(live("beta"), textNode("Closing prose")),
  }
  return { cards: out.map((c) => `${c.which}@${c.row}: ${c.what}`), order }
}, root)

// A queued thread opens in the board's pane from the human's latest message (ChatView's queue window), so
// the cards above it are drawn only once the window is opened back to the start.
const openWhole = async (page) => {
  for (let i = 0; i < 10; i++) {
    const more = await page.$("[data-load-earlier]")
    if (!more) return
    await more.click()
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("the transcript kept offering earlier messages")
}
const PAGE_ROOT = "body"
const COMPOSER = "textarea[data-surface='chatComposer']"
const errors = []
const browser = await launchHeadless()
step("browser up")
try {
  const page = await browser.newPage()
  page.on("pageerror", (e) => errors.push(String(e)))
  const answerCalls = []
  page.on("request", (req) => { if (req.method() === "POST" && /\/rpc\/(answerQuestions|followUp)/.test(req.url())) answerCalls.push(req.url().split("/rpc/")[1]) })
  await page.setViewport({ width: 1100, height: 3200, deviceScaleFactor: 2 })
  const settleTo = async (what, root, expected) => {
    let seen
    try {
      await until(what, async () => {
        seen = await readCards(page, root)
        return seen && seen.cards.join(" | ") === expected.join(" | ")
      }, 20_000)
    } catch (cause) {
      console.error("drawn:", seen)
      throw cause
    }
    return seen
  }
  // Which options are pressed on each live card asking `which`, in document order.
  const pressed = (which) => page.$$eval("article[data-question-id]", (cards, w) => cards
    .filter((el) => el.textContent.includes(`Which ${w} should ship?`))
    // The pressed button is labelled by a sibling, so the option row carries the text.
    .map((el) => [...el.querySelectorAll("[aria-pressed='true']")].map((b) => (b.closest("[data-question-option]") ?? b).textContent.trim()).join(",")), which)

  // AFTER THE RECAP: both questions live in the write-up, each under its own lead-in, and live in the recap.
  await page.goto(`${base}/project/${flags.slug}/thread/${slug}`, { waitUntil: "networkidle2" })
  step(`surface: ${await page.$("[data-pane-thread]") ? "the board's pane" : "the full-screen page"}`)
  const recap = await settleTo("the thread after the recap", PAGE_ROOT, ["alpha@0: live", "beta@0: live", "alpha@1: live", "beta@1: live"])
  assert.deepEqual(recap.order, { alphaUnderItsLeadIn: true, betaUnderItsLeadIn: true })
  assert.equal(await page.$$eval("article[data-question-copy]", (els) => els.length), 0, "no read-only copy while the human has sent nothing")

  // ONE ANSWER, TWO CARDS: a pick on the recap's beta is the write-up's beta's pick too.
  // A real pointer click (the option's handler does not answer a synthetic `.click()`), aimed again until it
  // lands: the transcript can still shift under a just-loaded page. A pick is a toggle, so it is re-aimed
  // only while nothing on the card is pressed yet.
  const recapBetaOption = () => page.$$eval("article[data-question-id]", (cards) => {
    const recapBeta = cards.filter((el) => el.textContent.includes("Which beta should ship?"))[1]
    const option = [...(recapBeta?.querySelectorAll("[data-question-option]") ?? [])].find((o) => o.textContent.includes("Beta two"))
    const el = option?.querySelector("button") ?? option
    el?.scrollIntoView({ block: "center" })
    const r = el?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })
  const bothPicked = async () => { const p = await pressed("beta"); return p.length === 2 && p.every((x) => /Beta two/.test(x)) }
  for (let attempt = 0; attempt < 5 && !(await bothPicked()); attempt++) {
    if ((await pressed("beta")).some((x) => x)) break
    await new Promise((r) => setTimeout(r, 400))
    const target = await recapBetaOption()
    assert.ok(target, "the recap's beta card has a Beta two option to pick")
    await page.mouse.click(target.x, target.y)
    await new Promise((r) => setTimeout(r, 600))
  }
  await until("the pick to show on both beta cards", bothPicked, 10_000)
  step(`pressed on each beta card: ${JSON.stringify(await pressed("beta"))}`)
  if (flags.shots) {
    mkdirSync(flags.shots, { recursive: true })
    const clip = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("article[data-question-id], article[data-question-copy]")]
      const lead = [...document.querySelectorAll("p")].find((p) => p.textContent.includes("Two calls are left"))
      const first = (lead ?? cards[0]).getBoundingClientRect()
      const last = cards[cards.length - 1].getBoundingClientRect()
      return { x: Math.max(0, first.left - 30), y: Math.max(0, first.top + window.scrollY - 20), width: Math.min(900, last.right - first.left + 60), height: last.bottom - first.top + 50 }
    })
    await page.screenshot({ path: join(flags.shots, "recap-live-shared-pick.png"), clip, captureBeyondViewport: false })
  }
  // Enter in the prompt box sends what is staged, once.
  await page.click(COMPOSER)
  await page.waitForFunction((c) => document.querySelector(c) === document.activeElement, {}, COMPOSER)
  await page.keyboard.press("Enter")
  await until("beta to settle", async () => (await openIds(slug)) === "alpha", 30_000)
  const answer = (await api.query("threadSettledQuestions", { slug })).questions.find((q) => q.spec?.handle === "beta")
  step(`beta settled with ${JSON.stringify(answer?.answer)}; sends on the wire: ${JSON.stringify(answerCalls)}`)
  assert.match(JSON.stringify(answer?.answer), /Beta two/)
  assert.equal(answerCalls.length, 1, "one send")
  // Answered, beta stands where its card's home was, the recap, and the write-up draws its answered copy.
  await settleTo("the thread after answering beta", PAGE_ROOT, ["alpha@0: live", "beta@0: answered copy", "alpha@1: live", "beta@1: answered"])

  // THE HUMAN TYPES, and the worker names alpha again: the older namings stay live, never greyed.
  await api.mutate("followUp", { slug, sessionId, message: "Move alpha" })
  await until("the turn after the human's reply", () => said(slug, "Alpha again, now that you have replied:"))
  await page.reload({ waitUntil: "networkidle2" })
  await openWhole(page)
  await settleTo("the thread after the human's reply", PAGE_ROOT, ["alpha@0: live", "beta@0: answered copy", "alpha@1: live", "beta@1: answered", "alpha@2: live"])
  // The write-up's alpha, the one a later sign-off named again, answers for all three: a pick there shows
  // on every alpha card, and the one send settles it.
  const writeUpAlphaOption = () => page.$$eval("article[data-question-id]", (cards) => {
    const first = cards.find((el) => el.textContent.includes("Which alpha should ship?"))
    const option = [...(first?.querySelectorAll("[data-question-option]") ?? [])].find((o) => o.textContent.includes("Alpha two"))
    const el = option?.querySelector("button") ?? option
    el?.scrollIntoView({ block: "center" })
    const r = el?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })
  const allAlphaPicked = async () => { const p = await pressed("alpha"); return p.length === 3 && p.every((x) => /Alpha two/.test(x)) }
  for (let attempt = 0; attempt < 5 && !(await allAlphaPicked()); attempt++) {
    if ((await pressed("alpha")).some((x) => x)) break
    await new Promise((r) => setTimeout(r, 400))
    const target = await writeUpAlphaOption()
    assert.ok(target, "the write-up's alpha card has an Alpha two option to pick")
    await page.mouse.click(target.x, target.y)
    await new Promise((r) => setTimeout(r, 600))
  }
  await until("the write-up's pick to show on all three alpha cards", allAlphaPicked, 10_000)
  step(`pressed on each alpha card: ${JSON.stringify(await pressed("alpha"))}`)
  if (flags.shots) {
    const clip = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("article[data-question-id], article[data-question-copy]")]
      const lead = [...document.querySelectorAll("p")].find((p) => p.textContent.includes("Two calls are left"))
      const first = (lead ?? cards[0]).getBoundingClientRect()
      const last = cards[cards.length - 1].getBoundingClientRect()
      return { x: Math.max(0, first.left - 30), y: Math.max(0, first.top + window.scrollY - 20), width: Math.min(900, last.right - first.left + 60), height: last.bottom - first.top + 50 }
    })
    await page.screenshot({ path: join(flags.shots, "after-reply-all-live.png"), clip, captureBeyondViewport: false })
  }
  await page.click(COMPOSER)
  await page.waitForFunction((c) => document.querySelector(c) === document.activeElement, {}, COMPOSER)
  await page.keyboard.press("Enter")
  await until("alpha to settle", async () => (await openIds(slug)) === "", 30_000)
  const alpha = (await api.query("threadSettledQuestions", { slug })).questions.find((q) => q.spec?.handle === "alpha")
  step(`alpha settled with ${JSON.stringify(alpha?.answer)}; sends on the wire: ${JSON.stringify(answerCalls)}`)
  assert.match(JSON.stringify(alpha?.answer), /Alpha two/)
  assert.equal(answerCalls.length, 2, "one send for alpha, after beta's")
  assert.deepEqual(errors, [], "the page raised no errors")
  console.log("ok — a wake-driven recap draws the questions live beside the write-up, sharing one answer")
} finally {
  await browser.close()
}
