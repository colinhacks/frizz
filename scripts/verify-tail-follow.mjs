// Verify TAIL FOLLOW in the thread transcript against a REAL running stack: a simulated worker's JSONL
// is appended to while a real browser watches /thread/<slug>, so everything under test is production's
// — tailer → board → socket push → react-query cache → virtualized transcript → scroll.
//
// The invariant: a reader parked AT the bottom stays there as the tail grows, and a reader who scrolled
// away is never hauled back. The bug this guards (fixed 2026-07-24) left the reader ~50-430px short
// whenever a reply landed while the runtime-status "Working…" row was the last row — TanStack's
// `followOnAppend` only fires when the LAST row's key changes, and that row's key never does.
//
// The seed deliberately ends on an unanswered user record so the turn is IN-FLIGHT and that Working…
// row is present: without it the thread is idle, the last row IS the new message, the library follow
// works on its own, and this harness passes while testing nothing. (It did, before a control run.)
//
// Usage — boot a disposable stack first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-tail-follow.mjs --home=/abs/temp-home --url=http://127.0.0.1:PORT/
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import puppeteer from "puppeteer"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, url } = flags
const cwd = flags.cwd ?? process.cwd()
const shotDir = flags.shots ?? tmpdir()
if (!home || !url) {
  console.error("usage: node scripts/verify-tail-follow.mjs --home=/abs/temp-home --url=http://127.0.0.1:PORT/")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const SLUG = "verify-tail-follow"
const SESSION = "tailfoll-0000-4000-8000-000000000000"
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const jsonl = join(jsonlDir, `${SESSION}.jsonl`)

const now = () => new Date().toISOString()
let n = 0
const base = () => ({ parentUuid: null, isSidechain: false, uuid: `${(++n).toString().padStart(8, "0")}-0000-4000-8000-000000000000`, timestamp: now(), session_id: SESSION, cwd })
const user = (text) => ({ ...base(), type: "user", message: { role: "user", content: text } })
// stop_reason omitted keeps the turn in-flight (the tailer's 5s quiet backstop), so Working… stays last.
const assistant = (text, stop = null) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text }], ...(stop ? { stop_reason: stop } : {}), usage: { input_tokens: 2, output_tokens: 80 } },
})
const prose = (paras, label) => Array.from({ length: paras }, (_, i) =>
  `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, quis nostrud exercitation ullamco laboris.`).join("\n\n")

const seed = []
for (let i = 0; i < 8; i++) {
  seed.push(user(`TASK:\nAsk ${i + 1}: keep working the tail-follow investigation.`))
  seed.push(assistant(prose(3, `Reply ${i + 1}`), "end_turn"))
}
seed.push(user("TASK:\nAsk 9: this turn is still in flight while we watch the tail."))
writeFileSync(jsonl, seed.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
  VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Tail follow', 'claude', 'opus', 'high', 'default')`])
const append = (record) => appendFileSync(jsonl, JSON.stringify(record) + "\n")

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(new URL(`/thread/${SLUG}`, url).href, { waitUntil: "networkidle2", timeout: 30000 })
  await page.waitForFunction("document.querySelector('[data-drawer-transcript-scroll] [data-virtualized-transcript]')", { timeout: 20000 })

  const settle = (ms = 1600) => page.evaluate(async (wait) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 20; i++) await raf()
    await new Promise((r) => setTimeout(r, wait))
    for (let i = 0; i < 20; i++) await raf()
  }, ms)
  const metrics = () => page.evaluate(() => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    return {
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      scrollTop: Math.round(el.scrollTop),
      jumpVisible: Boolean(document.querySelector("[data-jump-to-latest]")),
      working: Array.from(document.querySelectorAll(".shimmer-text")).some((s) => s.textContent.includes("Working")),
    }
  })
  const pin = async () => { await page.evaluate(() => { const el = document.querySelector("[data-drawer-transcript-scroll]"); el.scrollTop = el.scrollHeight }); await settle(300) }

  await settle()
  await pin()
  check("the harness reached the buggy configuration (a live turn, Working… is the last row)", (await metrics()).working)

  // A whole agent reply landing at once.
  append(assistant(prose(7, "A landing reply")))
  await settle()
  let m = await metrics()
  check("a big reply landing in one push keeps the reader at the bottom", m.distance === 0, `distance=${m.distance}`)
  await page.screenshot({ path: join(shotDir, "tail-follow-1-big-reply.png") })

  // A human follow-up enqueued mid-turn, then delivered — the enqueued→dequeued flip.
  const queuedText = "One more thing: please also check the narrow layout before you land this."
  await pin()
  append({ ...base(), type: "queue-operation", operation: "enqueue", content: queuedText })
  await settle()
  m = await metrics()
  check("an enqueued follow-up keeps the reader at the bottom", m.distance === 0, `distance=${m.distance}`)

  await pin()
  append({ ...base(), type: "attachment", attachment: { type: "queued_command", prompt: queuedText, origin: { kind: "human" }, commandMode: "prompt" } })
  await settle()
  m = await metrics()
  check("the enqueued→dequeued flip keeps the reader at the bottom", m.distance === 0, `distance=${m.distance}`)
  await page.screenshot({ path: join(shotDir, "tail-follow-2-dequeued.png") })

  append(assistant(prose(5, "Answering the follow-up")))
  await settle()
  m = await metrics()
  check("the reply to a delivered follow-up keeps the reader at the bottom", m.distance === 0, `distance=${m.distance}`)

  // A reader who wheels up mid-turn is left exactly where they are.
  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-drawer-transcript-scroll]").getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await page.mouse.move(box.x, box.y)
  for (let i = 0; i < 5; i++) { await page.mouse.wheel({ deltaY: -160 }); await new Promise((r) => setTimeout(r, 60)) }
  await settle(400)
  const wheeled = await metrics()
  check("wheeling up mid-turn detaches and shows Jump to latest", wheeled.distance > 400 && wheeled.jumpVisible, `distance=${wheeled.distance} jump=${wheeled.jumpVisible}`)
  append(assistant(prose(4, "A reply while the reader is up-thread")))
  await settle()
  m = await metrics()
  check("a reply landing while the reader is up-thread never moves them", m.scrollTop === wheeled.scrollTop, `scrollTop ${wheeled.scrollTop} → ${m.scrollTop}`)
  await page.screenshot({ path: join(shotDir, "tail-follow-3-up-thread.png") })

  // Jump to latest re-attaches.
  await page.click("[data-jump-to-latest]")
  await settle(800)
  m = await metrics()
  check("Jump to latest returns the reader to the tail", m.distance === 0 && !m.jumpVisible, `distance=${m.distance}`)
  append(assistant(prose(4, "A reply after jumping back to latest")))
  await settle()
  m = await metrics()
  check("the follow re-attaches after Jump to latest", m.distance === 0, `distance=${m.distance}`)

  // Narrow viewport.
  await page.setViewport({ width: 430, height: 880, deviceScaleFactor: 2 })
  await settle(600)
  await pin()
  append(assistant(prose(5, "A reply at narrow width")))
  await settle()
  m = await metrics()
  check("the follow holds at narrow width", m.distance === 0, `distance=${m.distance}`)
  await page.screenshot({ path: join(shotDir, "tail-follow-4-narrow.png") })

  check("no console or page errors", errors.length === 0, errors.join(" | "))
  console.log(`\nscreenshots → ${shotDir}/tail-follow-*.png`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
