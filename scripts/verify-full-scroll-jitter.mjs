// Verify that scrolling BACK through a long thread on /thread/<slug>/full moves the content by exactly
// what the reader asked for — no swallowed notches, no backward lurches.
//
// THE BUG THIS PINS. A row above the reader that has never been measured mounts at its ESTIMATE (108px
// for a message row) and then corrects to its real height, which on a real thread is routinely 300-750px.
// Each correction makes virtual-core compensate, and it writes that compensation as
// `scrollTo(getScrollOffset() + delta)` — where `getScrollOffset()` is its OWN CACHED offset, refreshed
// only when a scroll EVENT runs. Scroll events fire at the top of a frame and the ResizeObserver that
// triggers the correction fires at the bottom of it, so everything the reader scrolled in between is
// missing from that cached value and the write throws it away. The reader wheels and the transcript
// does not move.
//
// The measurement is the reader's own invariant, not an internal one: scroll by a fixed step every frame
// and one tracked row must travel by exactly that step every frame. A frame where it travels 0px is a
// notch the transcript ate.
//
// Usage — boot a disposable stack first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-full-scroll-jitter.mjs --home=… --url=… [--steps=200] [--step=40]
//     [--source=/abs/real.jsonl] [--seed-lines=1200]
//
// `--source` replays a REAL transcript instead of the synthetic seed, the way
// verify-full-replay-stability.mjs does — the shapes that actually break estimates (tool cards, code
// blocks, screenshot results, sub-agent cards) are the ones a hand-built seed never produces.
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
const steps = Number(flags.steps ?? 200)
const step = Number(flags.step ?? 40)
const label = flags.label ?? "run"
if (!home || !url) {
  console.error("usage: node scripts/verify-full-scroll-jitter.mjs --home=… --url=…")
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// `--projectId` still wins: a stack with more than one registered project needs to say which.
const projectId = flags.projectId ?? sandbox.projectId
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns({ ...sandbox, projectId })
const SLUG = "verify-scroll-jitter"
const SESSION = "scrljit0-0000-4000-8000-000000000000"
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

// HEIGHT VARIANCE IS THE POINT. A transcript of uniform rows would let any estimate be right; the bug
// only fires where the real height is far above the estimate, so the seed cycles one-liners against
// multi-paragraph replies the way a real thread does. Kept under the 300-message projection cap so the
// head trim (verify-full-window-slide.mjs) cannot confound the measurement.
const seed = []
if (flags.source) {
  // Real records re-keyed onto this sandbox session; content, tool blocks and sidechain flags are left
  // exactly as the worker wrote them.
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
  VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Scroll jitter', 'claude', 'opus', 'high', 'default')`])
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
    const samples = []
    let key = null
    let previousTop = null
    let taken = 0
    // Travel is the tracked row's own motion — NOT scrollTop, which a correction above the reader moves
    // by the corrected row's whole growth (on a replayed real transcript, by more than the reader scrolls).
    let travelled = 0
    // One scroll step per frame, and the tracked row's travel read at the top of the NEXT frame — so
    // every sample is a painted frame, which is exactly what the reader perceives. `scrollBy` (not a
    // synthesized wheel) because a synthesized WheelEvent does not scroll; the app's own reader-intent
    // listeners are fed separately so the transcript classifies this as a gesture, not as growth.
    await new Promise((resolve) => {
      const frame = () => {
        const rows = liveRows()
        const tracked = key ? rows.find((r) => r.dataset.transcriptRowKey === key) : null
        if (!tracked) {
          // Re-pick whenever the tracked row leaves the render window. Mid-pane, so it survives a while.
          const middle = scrollerTop() + scroller.clientHeight * 0.5
          const next = rows.find((r) => r.getBoundingClientRect().bottom > middle) ?? rows[0]
          key = next?.dataset.transcriptRowKey ?? null
          previousTop = next ? next.getBoundingClientRect().top - scrollerTop() : null
          samples.push({ repick: true })
        } else {
          const top = tracked.getBoundingClientRect().top - scrollerTop()
          samples.push({ moved: Math.round((top - previousTop) * 10) / 10, scrollTop: Math.round(scroller.scrollTop) })
          travelled += top - previousTop
          previousTop = top
        }
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -step, bubbles: true, cancelable: true }))
        Element.prototype.scrollBy.call(scroller, 0, -step)
        if (++taken >= steps || scroller.scrollTop <= 0) { resolve(); return }
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    const moves = samples.filter((s) => typeof s.moved === "number")
    // A frame counts as jitter when the content did not travel the step the reader asked for. The 6px
    // slack absorbs sub-pixel layout residue and the one-frame rounding of a fractional scrollTop.
    const swallowed = moves.filter((s) => Math.abs(s.moved - step) > 6)
    return {
      startedAt: Math.round(startedAt),
      endedAt: Math.round(scroller.scrollTop),
      frames: moves.length,
      travelled: Math.round(travelled),
      repicks: samples.filter((s) => s.repick).length,
      swallowed: swallowed.length,
      worst: swallowed.slice().sort((a, b) => Math.abs(b.moved - step) - Math.abs(a.moved - step)).slice(0, 10).map((s) => ({ moved: s.moved, error: Math.round(s.moved - step), scrollTop: s.scrollTop })),
    }
  }, { steps, step })

  const rate = result.frames === 0 ? 1 : result.swallowed / result.frames
  console.log(`${label}: ${result.swallowed}/${result.frames} frames swallowed (${(rate * 100).toFixed(1)}%), scrollTop ${result.startedAt} → ${result.endedAt}, ${result.repicks} re-picks`)
  if (result.worst.length) console.log(`  worst: ${result.worst.map((w) => `${w.error > 0 ? "+" : ""}${w.error}px@${w.scrollTop}`).join(", ")}`)

  check("the probe really travelled back through the transcript (not passing vacuously)",
    result.frames >= steps * 0.8 && result.travelled > steps * step * 0.6,
    `frames=${result.frames} travelled=${result.travelled}px of ${steps * step} asked`)
  check("scrolling back never swallows the reader's scroll",
    rate <= 0.02, `${result.swallowed}/${result.frames} frames (${(rate * 100).toFixed(1)}%) moved by something other than ${step}px`)

  await page.screenshot({ path: join(shotDir, `scroll-jitter-${label}.png`) })
  if (missing.length) console.log(`  404s (not failures): ${missing.slice(0, 5).join(", ")}`)
  check("no console or page errors", errors.filter((e) => !e.includes("status of 404")).length === 0, errors.slice(0, 3).join(" | "))
} finally {
  await browser.close()
}
process.exit(failures === 0 ? 0 : 1)
