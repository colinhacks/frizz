#!/usr/bin/env node
// VERIFY: the whole ANSWERING path of a registered question, on every kind, with each question drawn LIVE
// twice — in a write-up and in the recap a wake drove after it — against the real app on a real stack. It
// asserts on the bytes leaving the page and on what the worker received, not on a fixture's local state.
//
// What it pins:
//   1. Every kind is live in both messages naming it, sharing one answer (lib/questionShadow placeQuestions,
//      2026-11-10): a choice pick in one card shows in the other and opens the `when:` follow-up in both;
//      a multi's options toggled in either card add up; text and a secret typed in one box show in the other.
//   2. Nothing on a card sends by itself (settled 2026-07-26, when the one-click approval gate was retired):
//      a pick, a keystroke and Shift-Enter put nothing on the wire, and Shift-Enter writes a newline.
//   3. The × on either copy dismisses the one row: both cards close, every other staged answer stays.
//   4. Words typed in the prompt box survive a pick, and Enter on the options grid the pick focused sends
//      them with every staged answer as ONE follow-up (lib/sendScope). The worker receives every answer,
//      the secret by reference only, and after a reload every copy is drawn answered.
//
// It replaces two scripts that drove the board's queue card, which nothing has mounted since the
// one-thread pane replaced it on 2026-11-09, on fences seeded with no registered row, which a thread
// dispatched after 2026-09-11 draws read-only. The legacy grammar's answers are pinned in the browser by
// packages/web/src/components/oneSend.e2e.test.ts.
//
// The worker is scripts/scripted-claude.mjs behind the REAL broker, so the questions are registered by the
// server from its own fences, and the wake is a real `frizzctl timer` fired by the real scheduler. Boot a
// stack with the scheduler armed, from a shell with no Frizz worker variables, on a throwaway repo:
//
//   mkdir -p /tmp/qa-project && git -C /tmp/qa-project init -q
//   env -u FRIZZ_STATE_DIR -u FRIZZ_SERVER_LOCK -u FRIZZ_PROJECT_ID -u FRIZZ_NODE -u FRIZZ_THREAD \
//     -u FRIZZ_PERM_DIR -u FRIZZ_NATIVE_ASK nub scripts/adhoc-stack.mjs --port=47661 --wakers \
//     --project=/tmp/qa-project --claude-bin=$PWD/scripts/scripted-claude.mjs > /tmp/qa-stack.log 2>&1 &
//
// then, with its json line's port and slug:
//
//   nub scripts/verify-question-answer.mjs --port=47661 --slug=<project slug> [--shots=/abs/dir]
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
  console.error("usage: nub scripts/verify-question-answer.mjs --port=N --slug=<project slug> [--shots=/abs/dir]")
  process.exit(1)
}
const base = `http://127.0.0.1:${flags.port}`
const api = createRpcClient(`${base}/`, flags.slug)
if (!(await api.waitForHealth(30_000))) throw new Error(`no stack answers on ${base}`)

const fence = (...lines) => ["```question", ...lines, "```"].join("\n")
const ref = (id) => fence(`id: ${id}`)
const TIMER_TRAILER = "(One-off timer, set for"
// A made-up code: what matters is that it never reaches the transcript or the page.
const SECRET = "482913"
const NOTE = "Faster boot.\nFewer prompts."

const dir = mkdtempSync(join(tmpdir(), "question-answer-"))
const turns = join(dir, "turns.json")
writeFileSync(turns, JSON.stringify({
  think: 200,
  turns: [
    { name: "write-up", on: "Start",
      tools: [{ command: "frizzctl timer set --in-seconds 10 --prompt 'Check the nightly build' --description 'Check the nightly build'", description: "Setting a timer" }],
      text: [
        "Store lead-in: how settings survive a crash.",
        fence("id: store", "kind: choice", "question: Which store should ship?", "options:", "  - label: SQLite", "    recommended: true", "  - label: JSON file"),
        fence("id: store-path", "kind: choice", "when: store = SQLite", "question: Where should the database file live?", "options:", "  - Beside the sessions database", "  - In the project folder"),
        "Targets lead-in: what CI builds.",
        fence("id: targets", "kind: multi", "question: Which targets should the build cover?", "options:", "  - label: macOS", "    recommended: true", "  - label: Linux", "  - label: Windows"),
        "Note lead-in: the release note.",
        fence("id: note", "kind: text", "question: What should the release note say?"),
        "Code lead-in: the test account.",
        fence("id: otp", "kind: secret", "question: The one-time code for the test account"),
        "Gamma lead-in: one to dismiss.",
        fence("id: gamma", "kind: choice", "question: Which gamma should ship?", "options:", "  - label: Gamma one", "    recommended: true", "  - label: Gamma two"),
        "Closing prose.",
      ].join("\n\n") },
    { name: "recap", on: TIMER_TRAILER, text: ["Nothing has changed. All still open:", ref("store"), ref("targets"), ref("note"), ref("otp"), ref("gamma")].join("\n\n") },
    { name: "reply", on: "Ship it.", text: "Got the answers." },
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
const step = (what) => console.log(`${new Date().toISOString().slice(11, 19)}  ${what}`)
const threadOf = async (slug) => (await api.query("board")).threads.find((t) => t.id === slug)
const openIds = async (slug) => ((await threadOf(slug))?.questions ?? []).map((q) => q.spec.handle).sort().join(" ")
const transcript = async (slug) => (await api.query("threadTranscript", { slug })).messages ?? []
const said = async (slug, text) => (await transcript(slug)).some((m) => m.role === "assistant" && m.text?.includes(text))

const { slug } = await api.mutate("dispatch", { prompt: `[script file=${turns}] Start`, backend: "claude", title: "Question answer" })
step(`dispatched ${slug}`)
await until("five questions to register", async () => (await openIds(slug)) === "gamma note otp store targets")
await until("the timer-woken recap", () => said(slug, "All still open:"), 90_000)
// A card is answerable once the turn that drew it has ended.
await until("the recap's turn to end", async () => !["running", "spawning"].includes((await threadOf(slug))?.runtime), 60_000)
step("the recap is written and the thread is at rest")

// Each card's question, by a phrase of its text.
const NAMES = [["Which store", "store"], ["Which targets", "targets"], ["release note", "note"], ["one-time code", "otp"], ["Which gamma", "gamma"]]
const phrase = (name) => NAMES.find(([, n]) => n === name)[0]
const LIVE = "article[data-question-id]:not([data-settled-question])"
// Every question card in document order, as `<name>@<message>: <state>` — the message is the index among
// the distinct transcript rows holding a card.
const readCards = (page) => page.evaluate((NAMES) => {
  const cards = [...document.querySelectorAll("article[data-question-id], article[data-question-copy], article[data-question-closed]")]
  const rows = []
  return cards.map((el) => {
    const key = el.closest("[data-transcript-source-id]")?.getAttribute("data-transcript-source-id") ?? "?"
    if (!rows.includes(key)) rows.push(key)
    const name = NAMES.find(([needle]) => el.textContent.includes(needle))?.[1] ?? "?"
    const what = el.hasAttribute("data-question-closed")
      ? (el.hasAttribute("data-question-copy") ? "closed copy" : "closed")
      : el.hasAttribute("data-question-copy") ? (el.hasAttribute("data-settled-question") ? "answered copy" : "copy") : el.hasAttribute("data-settled-question") ? "answered" : "live"
    return `${name}@${rows.indexOf(key)}: ${what}`
  })
}, NAMES)
// The pressed options on each live card of `name`, in document order, its follow-up's included.
const pressed = (page, name) => page.$$eval(LIVE, (cards, needle) => cards
  .filter((el) => el.textContent.includes(needle))
  // The pressed button is labelled by a sibling, so the option row carries the text.
  .map((el) => [...el.querySelectorAll("[aria-pressed='true']")]
    .map((b) => (b.closest("[data-question-option]") ?? b).textContent.replace(/^[A-Z]\.\s*/, "").replace(/RECOMMENDED/i, "").trim()).join(",")), phrase(name))
const optionAt = (page, name, nth, label) => page.$$eval(LIVE, (cards, needle, nth, label) => {
  const card = cards.filter((el) => el.textContent.includes(needle))[nth]
  const option = [...(card?.querySelectorAll("[data-question-option]") ?? [])].find((o) => o.textContent.includes(label))
  const el = option?.querySelector("button") ?? option
  el?.scrollIntoView({ block: "center" })
  const r = el?.getBoundingClientRect()
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
}, phrase(name), nth, label)
// One real pointer click (the option's handler does not answer a synthetic `.click()`) on `label` in the
// nth live card of `name`. A pick is a toggle, so it is re-aimed only while the cards' state has not moved:
// the transcript can still shift under a page that has just loaded.
async function pick(page, name, nth, label, expected) {
  const before = JSON.stringify(await pressed(page, name))
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.ok(await optionAt(page, name, nth, label), `${name} card ${nth} has an option "${label}"`)
    await new Promise((r) => setTimeout(r, 300))
    const target = await optionAt(page, name, nth, label)
    await page.mouse.click(target.x, target.y)
    try { await until(`${name}: ${label}`, async () => JSON.stringify(await pressed(page, name)) !== before, 2_500); break } catch { /* re-aim */ }
  }
  await until(`${name} to read ${JSON.stringify(expected)}`, async () => JSON.stringify(await pressed(page, name)) === JSON.stringify(expected), 10_000)
    .catch(async (cause) => { console.error("pressed:", await pressed(page, name)); throw cause })
}
const boxIn = async (page, selector, name, nth) => {
  const handle = await page.evaluateHandle((selector, needle, LIVE, nth) => {
    const box = [...document.querySelectorAll(LIVE)].filter((el) => el.textContent.includes(needle))[nth]?.querySelector(selector)
    box?.scrollIntoView({ block: "center" })
    return box ?? null
  }, selector, phrase(name), LIVE, nth)
  const el = handle.asElement()
  assert.ok(el, `${name} card ${nth} has ${selector}`)
  return el
}
const valuesOf = (page, selector, name) => page.$$eval(LIVE, (cards, selector, needle) => cards
  .filter((el) => el.textContent.includes(needle)).map((el) => el.querySelector(selector)?.value ?? null), selector, phrase(name))

const TEXT_BOX = "textarea[data-surface='questionAnswer']"
const SECRET_BOX = "[data-secret-answer]"
const COMPOSER = "textarea[data-surface='chatComposer']"
const KINDS = ["store", "targets", "note", "otp", "gamma"]
const errors = []
const browser = await launchHeadless()
step("browser up")
try {
  const page = await browser.newPage()
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  const wire = []
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/rpc\/(answerQuestions|followUp|dismissQuestions)/.test(req.url())) {
      wire.push({ rpc: req.url().split("/rpc/")[1].split("?")[0], body: req.postData() ?? "" })
    }
  })
  const sends = () => wire.filter((w) => w.rpc !== "dismissQuestions")
  await page.setViewport({ width: 1100, height: 5200, deviceScaleFactor: 1 })
  await page.goto(`${base}/project/${flags.slug}/thread/${slug}`, { waitUntil: "networkidle2" })
  const expectCards = async (what, expected) => {
    let seen
    await until(what, async () => (seen = await readCards(page)).join(" | ") === expected.join(" | "), 20_000)
      .catch((cause) => { console.error("drawn:", seen); throw cause })
    step(`${what}: as expected`)
  }
  await expectCards("every kind live in the write-up and the recap", [...KINDS.map((k) => `${k}@0: live`), ...KINDS.map((k) => `${k}@1: live`)])

  // CHOICE AND ITS FOLLOW-UP: a pick in the write-up opens the follow-up in both cards, and the follow-up's
  // pick in the recap shows in both.
  await pick(page, "store", 0, "SQLite", ["SQLite", "SQLite"])
  await until("the follow-up to open in both store cards", async () => (await page.$$eval(LIVE, (els) => els.filter((el) => el.textContent.includes("Where should the database file live?")).length)) === 2, 10_000)
  await pick(page, "store", 1, "In the project folder", ["SQLite,In the project folder", "SQLite,In the project folder"])
  step("choice and follow-up: one answer across both cards")
  // MULTI: one option here; the other comes from the recap's card below, after the prompt box has words.
  await pick(page, "targets", 0, "Linux", ["Linux", "Linux"])
  // TEXT: Shift-Enter writes a newline, and the recap's box shows the same text.
  const note = await boxIn(page, TEXT_BOX, "note", 0)
  await note.click()
  await page.keyboard.type("Faster boot.")
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift")
  await page.keyboard.type("Fewer prompts.")
  await until("the note in both boxes", async () => JSON.stringify(await valuesOf(page, TEXT_BOX, "note")) === JSON.stringify([NOTE, NOTE]), 10_000)
  step("text: one answer across both cards, newline kept")
  // SECRET: typed in the recap, held in the write-up's box too.
  await (await boxIn(page, SECRET_BOX, "otp", 1)).type(SECRET)
  await until("the secret in both boxes", async () => JSON.stringify(await valuesOf(page, SECRET_BOX, "otp")) === JSON.stringify([SECRET, SECRET]), 10_000)
  step("secret: one answer across both cards")
  assert.deepEqual(sends(), [], "picks, keystrokes and Shift-Enter send nothing")

  // DISMISS on the recap's copy closes the one row: both cards close, every other staged answer stays.
  const dismiss = await page.evaluateHandle((LIVE) => [...document.querySelectorAll(LIVE)].filter((el) => el.textContent.includes("Which gamma"))[1]?.querySelector("[data-dismiss-question]"), LIVE)
  await dismiss.asElement().click()
  await until("gamma dismissed", async () => !(await openIds(slug)).includes("gamma"), 15_000)
  const staged = (s) => [...KINDS.slice(0, 4).map((k) => `${k}@0: ${s}`), "gamma@0: closed", ...KINDS.slice(0, 4).map((k) => `${k}@1: ${s}`), "gamma@1: closed copy"]
  await expectCards("gamma dismissed from the recap", staged("live"))
  assert.deepEqual(await pressed(page, "store"), ["SQLite,In the project folder", "SQLite,In the project folder"], "dismissing gamma kept the other picks")
  assert.deepEqual(await valuesOf(page, SECRET_BOX, "otp"), [SECRET, SECRET], "…and the secret")

  // THE PROMPT BOX: words typed there survive a pick, and Enter on the grid the pick focused sends them
  // with every staged answer, once.
  await page.click(COMPOSER)
  await page.type(COMPOSER, "Ship it.")
  await pick(page, "targets", 1, "Windows", ["Linux,Windows", "Linux,Windows"])
  assert.equal(await page.$eval(COMPOSER, (t) => t.value), "Ship it.", "the typed words survive a pick")
  assert.deepEqual(sends(), [], "…and the pick sent nothing")
  if (flags.shots) {
    mkdirSync(flags.shots, { recursive: true })
    await page.screenshot({ path: join(flags.shots, "question-answer-staged.png"), captureBeyondViewport: false })
  }
  await page.keyboard.press("Enter")
  await until("every question to settle", async () => (await openIds(slug)) === "", 30_000)
  await until("the worker's reply", () => said(slug, "Got the answers."), 60_000)
  step(`sends on the wire: ${JSON.stringify(sends().map((s) => s.rpc))}`)
  assert.equal(sends().length, 1, "one send")
  const body = JSON.parse(sends()[0].body)
  const input = body.json ?? body
  assert.equal(input.message, "Ship it.", "the typed words ride the send")
  const byQuestion = Object.fromEntries((input.answers ?? []).map((a) => [a.question, a]))
  assert.equal(Object.keys(byQuestion).length, 4, "four answers; the dismissed question is not among them")
  assert.deepEqual(byQuestion["Which store should ship?"].chosen, ["SQLite"])
  assert.deepEqual(byQuestion["Which store should ship?"].followUps?.map((f) => f.chosen), [["In the project folder"]])
  assert.deepEqual(byQuestion["Which targets should the build cover?"].chosen, ["Linux", "Windows"])
  assert.equal(byQuestion["What should the release note say?"].text, NOTE)
  assert.equal(byQuestion["The one-time code for the test account"].text, SECRET)

  // What the worker received, and what the page draws once server truth replaces the optimistic cards.
  const delivered = (await transcript(slug)).filter((m) => m.role === "user").map((m) => m.text ?? "").join("\n")
  for (const word of ["SQLite", "In the project folder", "Linux", "Windows", "Fewer prompts.", "Ship it."]) assert.ok(delivered.includes(word), `the worker received "${word}"`)
  assert.ok(!delivered.includes(SECRET), "the secret never reaches the transcript")
  step("the worker received every answer, the secret by reference only")
  await page.reload({ waitUntil: "networkidle2" })
  // Rested on the answer, the thread opens in the board's pane from the human's latest message (ChatView's
  // queue window): open it back to the start, or the cards above that message are not drawn.
  for (let i = 0; i < 10 && (await page.$("[data-load-earlier]")); i++) {
    await (await page.$("[data-load-earlier]"))?.click()
    await new Promise((r) => setTimeout(r, 500))
  }
  // Answered, each stands where its card's home was, the recap, and the write-up draws its answered copy.
  await expectCards("after a reload, every copy answered", [...KINDS.slice(0, 4).map((k) => `${k}@0: answered copy`), "gamma@0: closed", ...KINDS.slice(0, 4).map((k) => `${k}@1: answered`), "gamma@1: closed copy"])
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(SECRET), "the secret is drawn nowhere")
  if (flags.shots) await page.screenshot({ path: join(flags.shots, "question-answer-sent.png"), captureBeyondViewport: false })
  assert.deepEqual(errors, [], "the page raised no errors")
  console.log("ok — every kind, live in two messages, shares one answer and goes out in one send")
} finally {
  await browser.close()
}
