#!/usr/bin/env node
// VERIFY: every ```question fence that names a registered question draws it (ChatView's question-fence
// path): an OPEN question its live, answerable card at every fence naming it (2026-11-14), and an answered
// or closed one its card where it stood and a read-only COPY at every other fence (2026-11-06).
//
// Before 2026-11-06 a question drew ONE card, in the newest message naming it, and every older fence naming
// it drew nothing: a worker that re-listed its open questions at each rest left the previous rest's lead-ins
// ("When the gateway gains HTTP:") over empty space. The maintainer chose a full read-only copy, and on
// 2026-11-14 took the grey off an open one: "There's no reason to automatically gray out a question just
// because it's been reiterated by a later sign-off message."
//
// The worker is scripts/scripted-claude.mjs behind the REAL broker, so the questions are registered by the
// server from the worker's own fences, withdrawn by its own `frizzctl unask`, and answered through the real
// RPC. Three turns, three questions:
//
//   1. asks alpha, beta and gamma        2. references all three        3. withdraws gamma, references alpha
//   …with beta answered between 2 and 3. Then, on the full-screen thread page, top to bottom:
//
//   message 1: alpha → live    beta → answered copy       gamma → the closed card that asked it
//   message 2: alpha → live    beta → its answered card    gamma → closed copy
//   message 3: alpha → live
//
// Boot a stack with the scripted worker, from a shell with no Frizz worker variables, on a throwaway repo:
//
//   mkdir -p /tmp/qc-project && git -C /tmp/qc-project init -q
//   env -u FRIZZ_STATE_DIR -u FRIZZ_SERVER_LOCK -u FRIZZ_PROJECT_ID -u FRIZZ_NODE -u FRIZZ_THREAD \
//     -u FRIZZ_PERM_DIR -u FRIZZ_NATIVE_ASK nub scripts/adhoc-stack.mjs --port=47641 \
//     --project=/tmp/qc-project --claude-bin=$PWD/scripts/scripted-claude.mjs > /tmp/qc-stack.log 2>&1 &
//
// then, with its json line's port and slug:
//
//   nub scripts/verify-question-copies.mjs --port=47641 --slug=<project slug> [--shots=/abs/dir]
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
  console.error("usage: nub scripts/verify-question-copies.mjs --port=N --slug=<project slug> [--shots=/abs/dir]")
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

const dir = mkdtempSync(join(tmpdir(), "question-copies-"))
const turns = join(dir, "turns.json")
writeFileSync(turns, JSON.stringify({
  think: 200,
  turns: [
    { name: "asks", on: "Start", text: [
      "Three decisions.", "Alpha lead-in:", ask("alpha", "Which alpha should ship?", "Alpha one", "Alpha two"),
      "Beta lead-in:", ask("beta", "Which beta should ship?", "Beta one", "Beta two"),
      "Gamma lead-in:", ask("gamma", "Which gamma should ship?", "Gamma one", "Gamma two"),
    ].join("\n\n") },
    { name: "relist", on: "Relist", text: [
      "These three are still open.", "Alpha again:", ref("alpha"), "Beta again:", ref("beta"), "Gamma again:", ref("gamma"),
    ].join("\n\n") },
    { name: "withdraw", on: "Withdraw", tools: ["frizzctl unask gamma"], text: [
      "Gamma is decided, so alpha is the one left.", "Alpha once more:", ref("alpha"),
    ].join("\n\n") },
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
// A turn has ended once the transcript holds its final message.
const said = async (slug, text) => {
  const page = await api.query("threadTranscript", { slug })
  return (page.messages ?? []).some((m) => m.role === "assistant" && m.text?.includes(text))
}

const { slug, sessionId } = await api.mutate("dispatch", { prompt: `[script file=${turns}] Start`, backend: "claude", title: "Question copies" })
await until("the three questions to register", async () => (await openIds(slug)) === "alpha beta gamma")
await api.mutate("followUp", { slug, sessionId, message: "Relist" })
await until("the re-listing rest", () => said(slug, "These three are still open."))
const beta = (await threadOf(slug)).questions.find((q) => q.spec.handle === "beta")
await api.mutate("answerQuestions", { slug, answers: [{ questionId: beta.id, question: beta.spec.question, chosen: ["Beta one"] }] })
await until("beta to settle", async () => (await openIds(slug)) === "alpha gamma")
await api.mutate("followUp", { slug, sessionId, message: "Withdraw" })
await until("gamma to be withdrawn", async () => (await openIds(slug)) === "alpha")
await until("the last rest", () => said(slug, "Alpha once more:"))

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

const browser = await launchHeadless()
const errors = []
try {
  const page = await browser.newPage()
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setViewport({ width: 1100, height: 3200, deviceScaleFactor: 2 })
  await page.goto(`${base}/project/${flags.slug}/thread/${slug}`, { waitUntil: "networkidle2" })
  await openWhole(page)
  // Every question card the page draws, in document order: what it is, and which question.
  const read = () => page.$$eval("article[data-question-id], article[data-question-copy], article[data-question-fence]", (cards) => cards.map((el) => {
    const what = el.hasAttribute("data-question-copy")
      ? (el.hasAttribute("data-question-open") ? "open copy" : el.hasAttribute("data-settled-question") ? "answered copy" : `${el.getAttribute("data-question-closed")} copy`)
      : el.hasAttribute("data-settled-question") ? "answered"
      : el.hasAttribute("data-question-closed") ? el.getAttribute("data-question-closed")
      : el.querySelector("[data-dismiss-question]") ? "live" : "other"
    const which = /Which (\w+) should ship\?/.exec(el.textContent ?? "")?.[1] ?? "?"
    return `${which}: ${what}`
  }))
  const expected = [
    "alpha: live", "beta: answered copy", "gamma: withdrawn",
    "alpha: live", "beta: answered", "gamma: withdrawn copy",
    "alpha: live",
  ]
  let seen = []
  try {
    await until("the page to draw every card", async () => { seen = await read(); return seen.join("|") === expected.join("|") }, 20_000)
  } catch (cause) {
    console.error("drawn:", seen)
    throw cause
  }
  assert.deepEqual(seen, expected)
  // A copy is not answerable: no option on it is a button that stages a pick, and only the live card offers ×.
  assert.equal(await page.$$eval("article[data-question-copy] [data-dismiss-question]", (els) => els.length), 0)
  assert.equal(await page.$$eval("article[data-question-copy] textarea", (els) => els.length), 0)
  // An open question is never drawn as a copy: each of alpha's three fences draws it answerable, none greyed.
  assert.equal(await page.$$eval("article[data-question-copy][data-question-open]", (els) => els.length), 0)
  assert.deepEqual(await page.$$eval("article[data-question-id]:not([data-settled-question])", (els) => els.map((el) => ({
    alpha: el.textContent.includes("Which alpha should ship?"),
    options: el.querySelectorAll("[data-question-option]").length,
    greyed: Number(getComputedStyle(el).opacity) < 1,
  }))), Array(3).fill({ alpha: true, options: 2, greyed: false }))
  if (flags.shots) {
    mkdirSync(flags.shots, { recursive: true })
    const column = await page.$("[data-question-copy]")
    const box = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("article[data-question-id], article[data-question-copy], article[data-question-fence]")]
      const first = cards[0].getBoundingClientRect()
      const last = cards[cards.length - 1].getBoundingClientRect()
      return { x: Math.max(0, first.left - 40), y: Math.max(0, first.top + window.scrollY - 160), width: first.width + 80, height: last.bottom - first.top + 220 }
    })
    void column
    await page.screenshot({ path: join(flags.shots, "thread-page.png"), clip: box })
  }
  assert.deepEqual(errors, [], "the page raised no errors")
  console.log("ok — every fence draws its question:", seen.join(", "))
} finally {
  await browser.close()
}
