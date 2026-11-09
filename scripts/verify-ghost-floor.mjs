// End-to-end verification for the optimistic-send "ghost floor" (lib/transcript-sync.ts).
//
// The bug: an optimistic bubble is consumed only when the matching server record is observed FRESH
// exactly once. A send the provider never records (a steer that failed after the RPC acknowledged it,
// a re-send of text recorded once) left a 50%-opacity bubble pinned to the thread bottom FOREVER.
//
// This drives the REAL app in a REAL browser against a REAL disposable stack, in ONE page session
// (the optimistic bubble lives only in that page's react-query cache, so the whole scenario has to
// happen without a reload):
//   1. send a follow-up through the real composer into a thread whose pane is a dummy `sleep` — the
//      RPC succeeds, the provider never records it → a genuine ghost;
//   2. advance the session JSONL past the grace window → the ghost must RETIRE;
//   3. control: send again and actually record it → the bubble must LAND (solid) and survive any
//      further advance, proving the floor never eats a delivered message.
//
// Usage: node scripts/verify-ghost-floor.mjs --url=http://127.0.0.1:4933 --slug=… --jsonl=/abs/path.jsonl
import { appendFileSync, readFileSync } from "node:fs"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { url, slug, jsonl, shots = "/tmp" } = flags
if (!url || !slug || !jsonl) {
  console.error("usage: node verify-ghost-floor.mjs --url= --slug= --jsonl= [--shots=/tmp]")
  process.exit(1)
}

const GRACE_MS = 60_000
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

// The JSONL tail's timestamp is the server clock the floor reasons about; every appended record is
// offset from it so the test never depends on wall-clock timing.
const tailAt = () => {
  const lines = readFileSync(jsonl, "utf8").trim().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = JSON.parse(lines[i]).timestamp
    if (at) return Date.parse(at)
  }
  throw new Error("no timestamped record in the fixture JSONL")
}
const iso = (ms) => new Date(ms).toISOString()
let seq = 0
const append = (rec) => appendFileSync(jsonl, JSON.stringify(rec) + "\n")
// `live: true` uses stop_reason "tool_use", which the tailer reads as a turn still in flight
// (tailer.ts:40) — the thread goes RUNNING and the client polls. That is both the realistic setting
// for a stranded send (the agent worked on past it) and what makes the merge — and therefore the
// floor — run on a cadence this test can wait on rather than guess at.
const assistantAt = (ms, text, live = false) => append({
  type: "assistant", uuid: `gen-a${++seq}`, timestamp: iso(ms),
  message: { role: "assistant", id: `gm${seq}`, content: [{ type: "text", text }], stop_reason: live ? "tool_use" : "end_turn" },
})
const userAt = (ms, text) => append({ type: "user", uuid: `gen-u${++seq}`, timestamp: iso(ms), message: { role: "user", content: text } })

// Every rendered user bubble with its computed opacity — the ONLY thing the human can actually see.
// `queued` (optimistic or server-pending) is the 50%-opacity state.
const BUBBLES = `[...document.querySelectorAll('[class*="bg-user-bubble"]')].map((el) => ({
  text: el.innerText.trim().slice(0, 60),
  opacity: Number(getComputedStyle(el).opacity),
  // Which surface rendered it — the same slug can be mounted in the drawer AND a queue card at once,
  // so a naive document-wide count would read two surfaces as one duplicated bubble.
  surface: el.closest("[data-queue-card]") ? "queue-card"
    : el.closest("[data-thread-drawer]") ? "drawer"
    : el.closest("[data-standalone-thread]") ? "standalone" : "chat",
}))`

const browser = await launchHeadless()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 })
  const errors = []
  const notes = [] // warnings carry the floor's own retirement breadcrumb + the watchdog's
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
    else if (m.type() === "warning" || m.type() === "warn") notes.push(m.text())
  })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${url}?thread=${slug}`, { waitUntil: "networkidle2", timeout: 30000 })
  await page.waitForSelector('textarea[placeholder*="Follow up"]', { timeout: 15000 })

  const send = async (text) => {
    await page.focus('textarea[placeholder*="Follow up"]')
    await page.type('textarea[placeholder*="Follow up"]', text, { delay: 8 })
    await page.keyboard.press("Enter")
  }
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))
  // Scope every assertion to ONE surface: the same slug can be mounted in the thread chat AND a queue
  // card at once (they share the query cache), so a delivered message would otherwise read as a
  // duplicate. Collapse by text within the chat surface alone.
  const bubbles = async () => {
    const all = (await page.evaluate(BUBBLES)).filter((b) => b.surface === "chat")
    const byText = new Map()
    for (const b of all) {
      const entry = byText.get(b.text) ?? { text: b.text, opacity: 1, copies: 0 }
      entry.opacity = Math.min(entry.opacity, b.opacity)
      // "exactly one" means one bubble on screen for this text.
      entry.copies++
      byText.set(b.text, entry)
    }
    return [...byText.values()]
  }
  const find = (list, prefix) => list.find((b) => b.text.startsWith(prefix))
  const shot = (name) => page.screenshot({ path: `${shots}/${name}`, fullPage: false })
  // Level-triggered: the tailer/push/watchdog cadence is a few seconds and deliberately not tuned by
  // this test, so wait for the CONDITION rather than guessing a settle.
  const waitFor = async (label, predicate, timeoutMs = 45_000) => {
    const deadline = Date.now() + timeoutMs
    let last
    for (;;) {
      last = await bubbles()
      if (predicate(last)) return { ok: true, seen: last }
      if (Date.now() > deadline) return { ok: false, seen: last }
      await settle(1000)
    }
  }

  // ── 1. a send the provider never records → a ghost ──────────────────────────────────────────────
  const ghostText = "ghost-floor: never recorded"
  const anchor = tailAt()
  await send(ghostText)
  let r = await waitFor("queued", (s) => find(s, ghostText)?.opacity < 0.9, 15_000)
  check("a just-sent follow-up renders as a queued (dimmed) bubble", r.ok, JSON.stringify(r.seen))
  await shot("ghost-1-queued.png")

  // ── 2. the transcript advances past the grace window without ever recording it → retire ─────────
  const marker = "The agent moved on without ever receiving that send."
  assistantAt(anchor + 20_000, "Still working…", true)
  assistantAt(anchor + GRACE_MS + 30_000, marker, true)
  // Separate the two failure modes: the client never SEEING the advance (a transcript-liveness
  // problem, nothing to do with the floor) vs. seeing it and still holding the ghost (a real miss).
  const advanceRendered = await (async () => {
    const deadline = Date.now() + 45_000
    for (;;) {
      if (await page.evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})`)) return true
      if (Date.now() > deadline) return false
      await settle(1000)
    }
  })()
  check("the client renders the transcript advance at all (fixture liveness)", advanceRendered)
  r = await waitFor("retired", (s) => !find(s, ghostText))
  check("the stranded optimistic send is RETIRED once the transcript advances past it", r.ok, JSON.stringify(r.seen))
  await shot("ghost-2-retired.png")

  // ── 3. control: a send the provider DOES record must land solid and never be retired ────────────
  const landedText = "ghost-floor: actually delivered"
  const base = tailAt()
  await send(landedText)
  r = await waitFor("control queued", (s) => find(s, landedText)?.opacity < 0.9, 15_000)
  check("the control send also renders as a queued bubble first", r.ok, JSON.stringify(r.seen))
  userAt(base + 5_000, landedText)
  assistantAt(base + 10_000, "Got it.", true)
  r = await waitFor("control delivered", (s) => find(s, landedText)?.opacity >= 0.9)
  check("a recorded send flips to a solid (delivered) bubble", r.ok, JSON.stringify(r.seen))
  check("…and is rendered exactly once", find(r.seen, landedText)?.copies === 1, JSON.stringify(r.seen))

  // …and stays put no matter how far the transcript then advances past the floor's grace.
  assistantAt(base + 10_000 + GRACE_MS * 5, "Much later.", true)
  r = await waitFor("later advance rendered", (s) => s.length > 0 && find(s, landedText), 20_000)
  check("the delivered bubble is never eaten by the floor",
    Boolean(find(r.seen, landedText)) && find(r.seen, landedText).opacity >= 0.9, JSON.stringify(r.seen))
  await shot("ghost-3-delivered.png")

  if (notes.length) console.log("PAGE WARNINGS:\n  " + notes.join("\n  "))
  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"))
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed")
process.exit(failures ? 1 : 0)
