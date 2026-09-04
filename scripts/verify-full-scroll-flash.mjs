// Verify that a row-height correction while scrolling BACK through a long thread never PAINTS a frame
// with the scroll offset corrected but the rows not yet moved.
//
// THE BUG THIS PINS. A row above the reader mounts at its ESTIMATE and corrects to its real height on a
// ResizeObserver pass. virtual-core compensates by writing scrollTop inside that same pass — but the rows
// below the corrected one are positioned by React (`translateY(start)`), and the re-render that moves
// them is a plain `setState` from a non-React callback: a task that runs AFTER the frame paints. So the
// frame between them is painted with the reader's content shoved by the whole correction (300-700px on
// a real transcript), and the next frame snaps it back. That is the "re-rendering jitter" a reader sees
// on every scroll-up through unmeasured history — and verify-full-scroll-jitter.mjs cannot see it,
// because its per-frame samples read in rAF, after React has already caught up.
//
// The probe hooks the scroller's own `scrollTo` (the app's scrollToFn writes through it) and measures a
// tracked row's viewport position in a microtask right after the write — i.e. after the observer
// callback has fully returned, in the state the browser is about to paint. A frame where the tracked row
// sits somewhere other than where it was at the top of the frame, by more than the wheel step, is a flash.
//
// Usage — boot a disposable stack first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-full-scroll-flash.mjs --home=… --url=… [--steps=300] [--step=40]
//     [--source=/abs/real.jsonl] [--seed-lines=1200] [--label=…]
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync, readFileSync, globSync } from "node:fs"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, url } = flags
const cwd = flags.cwd ?? process.cwd()
const shotDir = flags.shots ?? tmpdir()
const steps = Number(flags.steps ?? 300)
const step = Number(flags.step ?? 40)
const label = flags.label ?? "run"
if (!home || !url) {
  console.error("usage: node scripts/verify-full-scroll-flash.mjs --home=… --url=…")
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// `--projectId` still wins: a stack with more than one registered project needs to say which.
const projectId = flags.projectId ?? sandbox.projectId
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns({ ...sandbox, projectId })
const SLUG = "verify-scroll-flash"
const SESSION = "scrlfla0-0000-4000-8000-000000000000"
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
const prose = (paras, seedLabel) => Array.from({ length: paras }, (_, i) =>
  `**${seedLabel} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.`).join("\n\n")

// Same seed as verify-full-scroll-jitter.mjs: height variance is the point, and a real transcript
// (`--source`) has the shapes — tool cards, code blocks, screenshots — that blow the estimate the most.
const seed = []
if (flags.source) {
  const raw = readFileSync(flags.source, "utf8").split("\n").filter((l) => l.trim().length > 0)
  for (const line of raw.slice(0, Number(flags["seed-lines"] ?? 1200))) {
    try {
      const record = JSON.parse(line)
      if (record.session_id) record.session_id = SESSION
      if (record.sessionId) record.sessionId = SESSION
      record.cwd = cwd
      seed.push(record)
    } catch { /* a truncated tail line is not worth failing the harness over */ }
  }
  console.log(`source ${flags.source}: seeded ${seed.length} real records`)
} else {
  for (let i = 0; i < 70; i++) {
    seed.push(user(`TASK:\nAsk ${i + 1}: ${i % 3 === 0 ? prose(1, `Ask ${i + 1}`) : "a short question."}`))
    seed.push(assistant(prose(1 + (i % 6), `Reply ${i + 1}`), "end_turn"))
  }
}
writeFileSync(jsonl, seed.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
  VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Scroll flash', 'claude', 'opus', 'high', 'default')`])
const api = createRpcClient(url)

let failures = 0
const check = (l, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  // A replayed real transcript references screenshots that do not exist in the sandbox; name them rather
  // than failing the run on a missing image the transcript itself asked for.
  const missing = []
  page.on("response", (r) => { if (r.status() === 404) missing.push(r.url()) })

  const projected = await api.query("threadTranscript", { slug: SLUG })
  check("the transcript is long enough to scroll back through",
    projected.messages.length >= 140, `messages=${projected.messages.length}`)

  await page.goto(new URL(`/thread/${SLUG}/full`, url).href, { waitUntil: "networkidle2", timeout: 60000 })
  await page.waitForFunction("document.querySelector('[data-standalone-thread] [data-drawer-transcript-scroll] [data-virtualized-transcript]')", { timeout: 40000 })
  await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 10; i++) await raf()
    await new Promise((r) => setTimeout(r, 3000))
    for (let i = 0; i < 10; i++) await raf()
  })

  const result = await page.evaluate(async ({ steps, step }) => {
    const scroller = document.querySelector("[data-drawer-transcript-scroll]")
    const scrollerTop = () => scroller.getBoundingClientRect().top
    const liveRows = () => Array.from(scroller.querySelectorAll("[data-transcript-row-key]"))
    const startedAt = scroller.scrollTop
    let key = null
    let frameTop = null
    let corrections = 0
    let travelled = 0
    let taken = 0
    const flashes = []
    const writes = []
    // Heights by row key as of the top of the frame, so a flash can name the row that grew.
    let heights = new Map()
    const allRows = () => Array.from(scroller.querySelectorAll("[data-transcript-row-key]"))
    const snapshotHeights = () => new Map(allRows().map((r) => [r.dataset.transcriptRowKey, Math.round(r.getBoundingClientRect().height)]))
    const grownSince = (previous) => allRows().flatMap((r) => {
      const k = r.dataset.transcriptRowKey
      const h = Math.round(r.getBoundingClientRect().height)
      const was = previous.get(k)
      return was === undefined ? [`${k.slice(0, 24)}:new ${h}`] : was !== h ? [`${k.slice(0, 24)}:${was}→${h}`] : []
    })
    // The hook: every write the virtualizer makes through the app's scrollToFn lands here. The tracked
    // row's position is read in a microtask, after the observer callback that wrote it has returned —
    // the state the browser paints next.
    const nativeScrollTo = Element.prototype.scrollTo
    scroller.scrollTo = function (...args) {
      const wasAt = this.scrollTop
      nativeScrollTo.apply(this, args)
      const wrote = Math.round(this.scrollTop - wasAt)
      corrections++
      const write = { frame: taken, wrote, asked: Math.round((args[0]?.top ?? args[1] ?? NaN) - wasAt), shove: null }
      writes.push(write)
      queueMicrotask(() => {
        if (key === null || frameTop === null) return
        const tracked = liveRows().find((r) => r.dataset.transcriptRowKey === key)
        if (!tracked) return
        const top = tracked.getBoundingClientRect().top - scrollerTop()
        const shove = Math.round(top - frameTop)
        write.shove = shove
        // The reader's own step for this frame is at most `step`; anything beyond that is the correction
        // painting on its own.
        if (Math.abs(shove) > step + 6) flashes.push({ shove, wrote, scrollTop: Math.round(scroller.scrollTop), grew: grownSince(heights).slice(0, 6) })
      })
    }
    await new Promise((resolve) => {
      const frame = () => {
        const rows = liveRows()
        let tracked = key ? rows.find((r) => r.dataset.transcriptRowKey === key) : null
        // Travel is the tracked row's own motion between frames, read in rAF once React has caught up
        // — NOT scrollTop, which a correction above the reader moves by the row's whole growth.
        if (tracked && frameTop !== null) travelled += tracked.getBoundingClientRect().top - scrollerTop() - frameTop
        if (!tracked) {
          const middle = scrollerTop() + scroller.clientHeight * 0.5
          tracked = rows.find((r) => r.getBoundingClientRect().bottom > middle) ?? rows[0]
          key = tracked?.dataset.transcriptRowKey ?? null
        }
        frameTop = tracked ? tracked.getBoundingClientRect().top - scrollerTop() : null
        heights = snapshotHeights()
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -step, bubbles: true, cancelable: true }))
        Element.prototype.scrollBy.call(scroller, 0, -step)
        if (++taken >= steps || scroller.scrollTop <= 0) { resolve(); return }
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    await new Promise((r) => setTimeout(r, 300))
    delete scroller.scrollTo
    return {
      startedAt: Math.round(startedAt),
      endedAt: Math.round(scroller.scrollTop),
      frames: taken,
      travelled: Math.round(travelled),
      corrections,
      writes,
      flashes: flashes.length,
      worst: flashes.slice().sort((a, b) => Math.abs(b.shove) - Math.abs(a.shove)).slice(0, 10),
    }
  }, { steps, step })

  console.log(`${label}: ${result.flashes} flash frames over ${result.frames} frames (${result.corrections} corrections), content travelled ${result.travelled}px, scrollTop ${result.startedAt} → ${result.endedAt}`)
  if ("verbose" in flags) console.log(`  writes: ${result.writes.map((w) => `f${w.frame}:${w.wrote > 0 ? "+" : ""}${w.wrote}(asked ${w.asked > 0 ? "+" : ""}${w.asked}, shove ${w.shove})`).join(" ")}`)
  if (result.worst.length) console.log(`  worst: ${result.worst.map((w) => `${w.shove > 0 ? "+" : ""}${w.shove}px@${w.scrollTop} (scrollTo wrote ${w.wrote > 0 ? "+" : ""}${w.wrote}; grew ${w.grew.join(" ")})`).join("\n         ")}`)

  check("the probe really travelled back through the transcript (not passing vacuously)",
    result.frames >= steps * 0.8 && result.travelled > steps * step * 0.8,
    `frames=${result.frames} travelled=${result.travelled}px of ${steps * step} asked`)
  check("the virtualizer actually corrected row heights along the way (the probe is exercised)",
    result.corrections > 0, `corrections=${result.corrections}`)
  check("no frame is painted with the correction applied but the rows not yet moved",
    result.flashes === 0, `${result.flashes} flash frames`)

  await page.screenshot({ path: join(shotDir, `scroll-flash-${label}.png`) })
  if (missing.length) console.log(`  404s (not failures): ${missing.slice(0, 5).join(", ")}`)
  check("no console or page errors", errors.filter((e) => !e.includes("status of 404")).length === 0, errors.slice(0, 3).join(" | "))
} finally {
  await browser.close()
}
process.exit(failures === 0 ? 0 : 1)
