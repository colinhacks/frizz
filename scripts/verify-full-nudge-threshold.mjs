// Characterize the ATTACHMENT THRESHOLD on /thread/<slug>/full: how far must a reader nudge up before
// the transcript stops hauling them back to the bottom on every append?
//
// The far-parked reader is already covered (verify-midscroll-stability, verify-full-replay-stability) and
// is solid. This measures the OTHER end of the range — the reader who scrolled up a little to re-read the
// last few lines. `TAIL_FOLLOW_PX` is the band inside which an append re-pins them, so anything inside it
// is by construction dragged back down; the question this answers is whether that band is small enough
// that no deliberate scroll-up ever lands inside it.
//
// For each target gap it re-pins to the bottom, wheels up to that gap with real wheel events, lets the
// reader-gesture window expire, then lands three real appends and reports whether the reader moved.
//
// Usage — boot a disposable stack first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-full-nudge-threshold.mjs --home=… --url=… [--gaps=24,48,96,200]
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
const gaps = (flags.gaps ?? "24,48,96,200,400").split(",").map(Number)
if (!home || !url) {
  console.error("usage: node scripts/verify-full-nudge-threshold.mjs --home=… --url=…")
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const SLUG = "verify-nudge"
const SESSION = "nudgethr-0000-4000-8000-000000000000"
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const jsonl = join(jsonlDir, `${SESSION}.jsonl`)

const now = () => new Date().toISOString()
let n = 0
const base = () => ({ parentUuid: null, isSidechain: false, uuid: `${(++n).toString().padStart(8, "0")}-0000-4000-8000-000000000000`, timestamp: now(), session_id: SESSION, cwd })
const user = (text) => ({ ...base(), type: "user", message: { role: "user", content: text } })
const assistant = (text, stop = null) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text }], ...(stop ? { stop_reason: stop } : {}), usage: { input_tokens: 2, output_tokens: 80 } },
})
const merged = (id, content) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id, type: "message", role: "assistant", content, usage: { input_tokens: 2, output_tokens: 40 } },
})
const prose = (paras, label) => Array.from({ length: paras }, (_, i) =>
  `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`).join("\n\n")

const seed = []
for (let i = 0; i < 8; i++) {
  seed.push(user(`TASK:\nAsk ${i + 1}: earlier settled exchange.`))
  seed.push(assistant(prose(2 + (i % 4), `Reply ${i + 1}`), "end_turn"))
}
seed.push(user(`TASK:\n${prose(3, "The standing ask")}`))
for (let i = 0; i < 12; i++) seed.push(assistant(prose(3 + (i % 3), `Working step ${i + 1}`)))
let tailId = `msg_${n}`
writeFileSync(jsonl, seed.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
  VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Nudge threshold', 'claude', 'opus', 'high', 'default')`])
const append = (record) => appendFileSync(jsonl, JSON.stringify(record) + "\n")

let failures = 0
const check = (l, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
const rows = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(new URL(`/thread/${SLUG}/full`, url).href, { waitUntil: "networkidle2", timeout: 40000 })
  await page.waitForFunction("document.querySelector('[data-standalone-thread] [data-drawer-transcript-scroll] [data-virtualized-transcript]')", { timeout: 30000 })

  const settle = (ms) => page.evaluate(async (wait) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 10; i++) await raf()
    await new Promise((r) => setTimeout(r, wait))
    for (let i = 0; i < 10; i++) await raf()
  }, ms)
  const probe = (key) => page.evaluate((k) => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    const boxEl = document.querySelector("[data-virtualized-transcript]")
    const top = el.getBoundingClientRect().top
    const all = Array.from(boxEl.querySelectorAll("[data-transcript-row-key]"))
      .map((r) => ({ key: r.dataset.transcriptRowKey, y: r.getBoundingClientRect().top - top, h: r.getBoundingClientRect().height }))
      .sort((a, b) => a.y - b.y)
    const named = k ? all.find((r) => r.key === k) : undefined
    const chosen = named ?? all.find((r) => r.y + r.h > 240) ?? all[0]
    return {
      key: chosen?.key ?? null,
      y: chosen ? Math.round(chosen.y) : null,
      found: Boolean(named),
      scrollTop: Math.round(el.scrollTop),
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      jumpVisible: Boolean(document.querySelector("[data-jump-to-latest]")),
    }
  }, key ?? null)
  const pin = async () => {
    await page.evaluate(() => { const el = document.querySelector("[data-drawer-transcript-scroll]"); el.scrollTop = el.scrollHeight })
    await settle(700)
  }
  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-drawer-transcript-scroll]").getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await page.mouse.move(box.x, box.y)
  await settle(2000)

  // THE BOTTOM RESIDUE. How far off the true bottom does a reader who is *visually pinned* actually
  // measure? That number is the only defensible size for the attachment epsilon: bigger than it and a
  // deliberate nudge gets swallowed, smaller and a reader who flung to the bottom reads as detached.
  // Measured over both ways of arriving there, at both device pixel ratios, at two pane heights.
  const residue = []
  for (const dpr of [1, 2]) {
    for (const height of [900, 741]) {
      await page.setViewport({ width: 1280, height, deviceScaleFactor: dpr })
      await settle(600)
      await page.evaluate(() => { const el = document.querySelector("[data-drawer-transcript-scroll]"); el.scrollTop = el.scrollHeight })
      await settle(500)
      const written = await page.evaluate(() => {
        const el = document.querySelector("[data-drawer-transcript-scroll]")
        return el.scrollHeight - el.scrollTop - el.clientHeight
      })
      // Now arrive the way a reader does: fling down into the clamp.
      await page.evaluate(() => { const el = document.querySelector("[data-drawer-transcript-scroll]"); el.scrollTop = el.scrollHeight - el.clientHeight - 600 })
      await settle(400)
      await page.mouse.move(box.x, Math.min(box.y, height - 100))
      for (let i = 0; i < 12; i++) { await page.mouse.wheel({ deltaY: 200 }); await new Promise((r) => setTimeout(r, 25)) }
      await settle(700)
      const flung = await page.evaluate(() => {
        const el = document.querySelector("[data-drawer-transcript-scroll]")
        return el.scrollHeight - el.scrollTop - el.clientHeight
      })
      residue.push({ dpr, height, written, flung })
      console.log(`residue dpr=${dpr} pane=${height}: after a written scrollTop=scrollHeight → ${written.toFixed(3)}px; after a wheel fling into the clamp → ${flung.toFixed(3)}px`)
    }
  }
  const worst = Math.max(...residue.map((r) => Math.max(Math.abs(r.written), Math.abs(r.flung))))
  console.log(`worst observed bottom residue: ${worst.toFixed(3)}px\n`)
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  await settle(600)
  await page.mouse.move(box.x, box.y)

  for (const gap of gaps) {
    await pin()
    // Wheel up to the target gap, closing in so the achieved gap is near the intended one.
    for (let i = 0; i < 80; i++) {
      const d = (await probe()).distance
      if (d >= gap) break
      await page.mouse.wheel({ deltaY: -Math.max(12, Math.min(120, gap - d)) })
      await new Promise((r) => setTimeout(r, 30))
    }
    // The reader-gesture window (700ms) must fully expire, or `readerMoved` still masks the follow.
    await settle(1600)
    const parked = await probe()
    const anchorKey = parked.key

    // Three real appends, the way a live turn streams: a tool call merged into the tail message, its
    // result, then a fresh message.
    append(merged(tailId, [{ type: "tool_use", id: `toolu_nudge_${gap}`, name: "Read", input: { file_path: `/Users/x/src/file-${gap}.ts` } }]))
    await settle(900)
    append({ ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_nudge_${gap}`, content: "ok" }] } })
    await settle(900)
    append(assistant(prose(4, `Landing reply at gap ${gap}`)))
    await settle(1800)
    tailId = `msg_${n}`

    const after = await probe(anchorKey)
    const moved = !after.found || after.y !== parked.y
    rows.push({ gap, parkedDistance: parked.distance, attached: !parked.jumpVisible, drift: after.found ? after.y - parked.y : null, endDistance: after.distance })
    console.log(`gap≈${String(gap).padStart(4)}px → parked at ${String(parked.distance).padStart(4)}px (attached=${!parked.jumpVisible}); after 3 appends: drift=${after.found ? `${after.y - parked.y}px` : "row gone"}, distance=${after.distance}`)
    check(
      `a reader parked ${parked.distance}px above the bottom is left alone by three appends`,
      !moved,
      `drift ${after.found ? `${after.y - parked.y}px` : "anchor row left the window"}, distance ${parked.distance} → ${after.distance}`,
    )
    await page.screenshot({ path: join(shotDir, `nudge-${gap}.png`) })
  }

  console.log("\ngap   parked  attached  drift   endDistance")
  for (const r of rows) console.log(`${String(r.gap).padStart(4)}  ${String(r.parkedDistance).padStart(6)}  ${String(r.attached).padStart(8)}  ${String(r.drift).padStart(5)}  ${String(r.endDistance).padStart(11)}`)
  check("no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "))
  console.log(`\nscreenshots → ${shotDir}/nudge-*.png`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
