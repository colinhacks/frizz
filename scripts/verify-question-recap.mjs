#!/usr/bin/env node
// VERIFY: a recap the worker writes after a WAKE, before the human's next turn, leaves each question's
// answerable card in the write-up that set it up, and draws read-only copies pointing UP at them
// (lib/questionShadow placeQuestions, 2026-11-09). Only a turn the human puts in lets a later reference
// take the card.
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
//   after 2, thread page: write-up alpha live, beta live; recap alpha copy ↑, beta copy ↑
//   after 2, queue card:  the same
//   after 3, thread page: write-up alpha copy ↓, beta live; recap alpha copy ↓, beta copy ↑; turn 3 alpha live
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
      tools: [{ command: "frizzctl timer set --in-seconds 10 --prompt 'Check the nightly build'", description: "Setting a timer" }],
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
    const what = el.hasAttribute("data-question-copy")
      ? `copy ${el.getAttribute("data-question-open") === "above" ? "↑" : "↓"}${el.hasAttribute("data-settled-question") ? " answered" : ""}`
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

const PAGE_ROOT = "body"
const CARD_ROOT = `[data-queue-card-root="${slug}"]`
const errors = []
const browser = await launchHeadless()
step("browser up")
try {
  const page = await browser.newPage()
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setViewport({ width: 1100, height: 3200, deviceScaleFactor: 2 })
  const settleTo = async (what, root, expected, open) => {
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

  // AFTER THE RECAP, ON THE THREAD PAGE: both cards still live in the write-up, each under its own lead-in.
  await page.goto(`${base}/project/${flags.slug}/thread/${slug}`, { waitUntil: "networkidle2" })
  const recapPage = await settleTo("the thread page after the recap", PAGE_ROOT, [
    "alpha@0: live", "beta@0: live", "alpha@1: copy ↑", "beta@1: copy ↑",
  ])
  assert.deepEqual(recapPage.order, { alphaUnderItsLeadIn: true, betaUnderItsLeadIn: true })
  assert.equal(await page.$$eval("article[data-question-copy]", (els) => els.filter((el) => /answer it above/.test(el.textContent)).length), 2, "each recap copy says the card is above it")
  if (flags.shots) {
    mkdirSync(flags.shots, { recursive: true })
    const clip = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("article[data-question-id], article[data-question-copy]")]
      const lead = [...document.querySelectorAll("p")].find((p) => p.textContent.includes("Two calls are left"))
      const first = (lead ?? cards[0]).getBoundingClientRect()
      const last = cards[cards.length - 1].getBoundingClientRect()
      return { x: Math.max(0, first.left - 30), y: Math.max(0, first.top + window.scrollY - 20), width: Math.min(900, last.right - first.left + 60), height: last.bottom - first.top + 50 }
    })
    await page.screenshot({ path: join(flags.shots, "thread-page-after-recap.png"), clip })
  }

  // THE QUEUE CARD draws the same: the window opens on the dispatch prompt, the human's last turn.
  await page.goto(`${base}/project/${flags.slug}`, { waitUntil: "networkidle2" })
  await page.waitForSelector(CARD_ROOT, { timeout: 20_000 })
  const recapCard = await settleTo("the queue card after the recap", CARD_ROOT, [
    "alpha@0: live", "beta@0: live", "alpha@1: copy ↑", "beta@1: copy ↑",
  ])
  assert.deepEqual(recapCard.order, { alphaUnderItsLeadIn: true, betaUnderItsLeadIn: true })
  if (flags.shots) {
    const card = await page.$(CARD_ROOT)
    await card.screenshot({ path: join(flags.shots, "queue-card-after-recap.png") })
  }

  // THE HUMAN TYPES, and the worker names alpha again: now that reference takes alpha's card. Beta, named
  // nowhere since, stays live in the write-up.
  await api.mutate("followUp", { slug, sessionId, message: "Move alpha" })
  await until("the turn after the human's reply", () => said(slug, "Alpha again, now that you have replied:"))
  await page.goto(`${base}/project/${flags.slug}/thread/${slug}`, { waitUntil: "networkidle2" })
  await settleTo("the thread page after the human's reply", PAGE_ROOT, [
    "alpha@0: copy ↓", "beta@0: live", "alpha@1: copy ↓", "beta@1: copy ↑", "alpha@2: live",
  ])

  // ANSWERING beta leaves its answered card where the live one stood: in the write-up.
  const beta = (await threadOf(slug)).questions.find((q) => q.spec.handle === "beta")
  await api.mutate("answerQuestions", { slug, answers: [{ questionId: beta.id, question: beta.spec.question, chosen: ["Beta one"] }] })
  await until("beta to settle", async () => (await openIds(slug)) === "alpha")
  await page.reload({ waitUntil: "networkidle2" })
  await settleTo("the thread page after answering beta", PAGE_ROOT, [
    "alpha@0: copy ↓", "beta@0: answered", "alpha@1: copy ↓", "beta@1: copy ↓ answered", "alpha@2: live",
  ])
  assert.deepEqual(errors, [], "the page raised no errors")
  console.log("ok — a wake-driven recap leaves the cards in the write-up, and the human's turn moves them")
} finally {
  await browser.close()
}
