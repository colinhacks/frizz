// The human's own words need air inside their bubble. The off-white bubble carried px-3.5 py-2, so the
// text sat 8px off the top and bottom edge against 14px left and right — visibly tight, and tighter than
// every card in the transcript. This pins the corrected rhythm: 12px vertical (maintainer 2026-08-01,
// "about 4px more padding above and below every user message"), 14px horizontal UNCHANGED.
//
// It drives the REAL pipeline — JSONL → tailer → transcript → ChatView — with a simulated worker, because
// a fixture can't: the frizz server mounts Vite with appType "custom", so every *.html falls back to
// index.html and only the real thread route renders a real transcript.
//
// Usage: nub scripts/verify-user-bubble-padding.mjs --port=4930 --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"

import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4930"))
const home = opt("home")
const cwd = opt("project", process.cwd())
const shots = opt("shots", "/tmp")
mkdirSync(shots, { recursive: true })
if (!home) throw new Error("--home=<stack temp HOME> is required (the adhoc stack prints it as `home`)")

const SLUG = "user-bubble-padding-check"
// A FRESH session id per run: the server caches the transcript projection PER SESSION, so a fixed id
// makes a re-run silently assert against the previous run's parse.
const SESSION_ID = randomUUID()
const now = new Date().toISOString()

const logDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(logDir, { recursive: true })
const base = { isSidechain: false, userType: "external", cwd, sessionId: SESSION_ID, version: "2.1.220", gitBranch: "main" }
const records = []
let n = 0
const push = (rec) => records.push({ ...base, ...rec, parentUuid: records.length ? records.at(-1).uuid : null, uuid: `0000000${++n}-0000-0000-0000-000000000000`.slice(-36), timestamp: now })
const user = (text) => push({ type: "user", message: { role: "user", content: text } })
const assistant = (text) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text }] } })

user("Short one.")
assistant("A short reply so the bubble above it stands alone in the column.")
user("A longer ask that wraps onto a second line so the block's interior padding is judgeable against a real multi-line paragraph rather than a single tight row of text.")
assistant("Understood — that one wraps.")
user("First of a back-to-back pair.")
user("Second of the pair, so the plain step between two human turns is visible too.")
assistant("Both received. This reply gives the pinned bubble something to float over.")

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const threadName = `frizz-${SLUG}`

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
  (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
  VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', '${threadName}', '${now}', 'User bubble padding check', 'claude', 'opus', 'high', 'default', 0, 0, 0, 0, 0, 0);`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

const { default: puppeteer } = await import("puppeteer")
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const failures = []
const pageErrors = []
const check = (ok, label, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`) }
try {
  const page = await browser.newPage()
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()) })
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 })
  await page.goto(`http://127.0.0.1:${port}/thread/${SLUG}`, { waitUntil: "networkidle0" })
  await page.waitForSelector(".bg-user-bubble", { timeout: 20_000 })
  // The transcript loads TAIL-FIRST, so the earlier bubbles live behind "Load earlier messages".
  for (let i = 0; i < 5; i++) {
    const more = await page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Load earlier messages") ?? null)
    const el = more.asElement()
    if (!el) break
    await el.click()
    await new Promise((r) => setTimeout(r, 700))
  }

  const measured = await page.evaluate(() => {
    const px = (v) => Math.round(parseFloat(v) * 100) / 100
    return [...document.querySelectorAll(".bg-user-bubble")].map((b) => {
      const cs = getComputedStyle(b)
      const r = b.getBoundingClientRect()
      // The INK-to-edge distance, not just the declared box: a Range over the bubble's own text nodes
      // reports where the first and last line boxes actually sit inside the padding box.
      const range = document.createRange()
      range.selectNodeContents(b)
      const lines = [...range.getClientRects()].filter((c) => c.height > 0)
      range.detach?.()
      return {
        text: b.textContent.trim().slice(0, 32),
        top: px(cs.paddingTop),
        bottom: px(cs.paddingBottom),
        left: px(cs.paddingLeft),
        right: px(cs.paddingRight),
        height: px(r.height),
        // Gap from the padding box edge to the first/last LINE BOX (padding + half-leading).
        inkTop: lines.length ? px(lines[0].top - r.top) : null,
        inkBottom: lines.length ? px(r.bottom - lines[lines.length - 1].bottom) : null,
      }
    })
  })
  console.log(JSON.stringify(measured, null, 2))

  check(measured.length === 4, "all four user bubbles rendered", `saw ${measured.length}`)
  check(measured.every((m) => m.top === 12 && m.bottom === 12), "every bubble carries 12px above and below", JSON.stringify(measured.map((m) => [m.top, m.bottom])))
  check(measured.every((m) => m.left === 14 && m.right === 14), "horizontal padding is UNCHANGED at 14px", JSON.stringify(measured.map((m) => [m.left, m.right])))
  // Half-leading splits evenly around the line box, so the INK gap is padding + ~1.5px on each side and
  // lands within a pixel of symmetric. This is what fails if the padding is ever split unevenly.
  check(measured.every((m) => Math.abs(m.inkTop - m.inkBottom) <= 1), "the text sits optically centred in the bubble", JSON.stringify(measured.map((m) => [m.inkTop, m.inkBottom])))
  const single = measured.find((m) => m.text.startsWith("Short one"))
  check(single && single.height === 44, "a one-line bubble is 44px tall (12 + 20px line + 12)", JSON.stringify(single))
  check(pageErrors.length === 0, "no console or page errors", pageErrors.join(" | "))

  const first = await page.$(".bg-user-bubble")
  await first.screenshot({ path: join(shots, "user-bubble-closeup.png") })
  await page.screenshot({ path: join(shots, "user-bubble-desktop.png") })
  await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })
  await page.reload({ waitUntil: "networkidle0" })
  await page.waitForSelector(".bg-user-bubble", { timeout: 20_000 })
  await page.screenshot({ path: join(shots, "user-bubble-narrow.png") })
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
