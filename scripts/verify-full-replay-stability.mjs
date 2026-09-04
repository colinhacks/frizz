// REPLAY a REAL Claude transcript into /thread/<slug>/full, one record at a time, and report every
// append that moves a reader parked mid-thread.
//
// Why this exists: the synthetic harnesses (verify-tail-follow, verify-midscroll-stability,
// verify-full-append-stability) each seed prose messages and append a handful of hand-built records.
// They pass — and they still missed the reported bug, because a real working turn's appends are nothing
// like a synthetic one: tool cards with dynamic disclosure heights, code blocks, base64 screenshot
// results, sub-agent dispatch/return cards, sidechain records, and a 300-message render window that
// TRIMS off the head as the turn grows. This replays the real bytes so the shapes under test are the
// ones that actually happen.
//
// It is a DIAGNOSTIC first: it names the exact record that moved the reader, so a fix has a target.
//
// Usage — boot a disposable stack first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-full-replay-stability.mjs --home=/abs/temp-home \
//     --url=http://127.0.0.1:PORT/ --source=/abs/real.jsonl [--park=800] [--replay=200] [--seed-lines=600]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import puppeteer from "puppeteer"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, url, source } = flags
const cwd = flags.cwd ?? process.cwd()
const shotDir = flags.shots ?? tmpdir()
const parkTarget = Number(flags.park ?? 800)
const replayCount = Number(flags.replay ?? 200)
const seedLines = Number(flags["seed-lines"] ?? 600)
if (!home || !url || !source) {
  console.error("usage: node scripts/verify-full-replay-stability.mjs --home=… --url=… --source=/abs/real.jsonl")
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const SLUG = `replay-${parkTarget}`
const SESSION = `replay${String(parkTarget).padStart(3, "0")}-0000-4000-8000-000000000000`.slice(0, 36)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const jsonl = join(jsonlDir, `${SESSION}.jsonl`)

// Real records, re-keyed onto this sandbox session. Everything else — content, tool blocks, sidechain
// flags, timestamps — is left exactly as the worker wrote it.
const raw = readFileSync(source, "utf8").split("\n").filter((l) => l.trim().length > 0)
const rekey = (line) => {
  try {
    const rec = JSON.parse(line)
    if (rec.session_id) rec.session_id = SESSION
    if (rec.sessionId) rec.sessionId = SESSION
    rec.cwd = cwd
    return JSON.stringify(rec)
  } catch {
    return null
  }
}
const records = raw.map(rekey).filter(Boolean)
const seed = records.slice(0, seedLines)
const replay = records.slice(seedLines, seedLines + replayCount)
if (replay.length === 0) throw new Error(`nothing to replay: ${records.length} records, seed-lines=${seedLines}`)
console.log(`source ${source}: ${records.length} records — seeding ${seed.length}, replaying ${replay.length}`)

writeFileSync(jsonl, seed.join("\n") + "\n")
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
  VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${new Date().toISOString()}', 'Replay ${parkTarget}px', 'claude', 'opus', 'high', 'default')`])

// A one-line label for the record that just landed, so a drift report names its own cause.
const label = (line) => {
  try {
    const r = JSON.parse(line)
    const content = r.message?.content
    const blocks = Array.isArray(content) ? content : []
    const kinds = blocks.map((b) => (b?.type === "tool_use" ? `tool_use:${b.name}` : b?.type === "tool_result" ? "tool_result" : b?.type)).join("+")
    const id = r.message?.id ? ` id=${r.message.id}` : ""
    return `${r.type}${r.isSidechain ? "(side)" : ""} ${kinds || (typeof content === "string" ? "text" : "")}${id}`.trim()
  } catch {
    return "unparseable"
  }
}

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
  await page.goto(new URL(`/thread/${SLUG}/full`, url).href, { waitUntil: "networkidle2", timeout: 60000 })
  await page.waitForFunction("document.querySelector('[data-standalone-thread] [data-drawer-transcript-scroll] [data-virtualized-transcript]')", { timeout: 40000 })

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
      scrollHeight: el.scrollHeight,
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      jumpVisible: Boolean(document.querySelector("[data-jump-to-latest]")),
    }
  }, key ?? null)

  await settle(2500)
  // Park the reader ~parkTarget px from the bottom, using real wheel gestures.
  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-drawer-transcript-scroll]").getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await page.mouse.move(box.x, box.y)
  for (let i = 0; i < 60; i++) {
    if ((await probe()).distance >= parkTarget) break
    await page.mouse.wheel({ deltaY: -200 })
    await new Promise((r) => setTimeout(r, 40))
  }
  // Let the reader-gesture window (700ms) fully expire before anything lands.
  await settle(1500)

  let m = await probe()
  check(`the reader is parked ~${parkTarget}px from the bottom, detached`, m.distance > parkTarget * 0.5 && m.jumpVisible, `distance=${m.distance} jump=${m.jumpVisible}`)
  const anchorKey = m.key
  let lastY = m.y
  await page.screenshot({ path: join(shotDir, `replay-${parkTarget}-0-parked.png`) })
  console.log(`parked: anchor=${anchorKey} y=${lastY} distance=${m.distance} scrollTop=${m.scrollTop}`)

  const drifts = []
  let vanished = 0
  for (let i = 0; i < replay.length; i++) {
    appendFileSync(jsonl, replay[i] + "\n")
    await settle(320)
    const after = await probe(anchorKey)
    if (!after.found) { vanished++; break }
    const drift = after.y - lastY
    if (Math.abs(drift) > 2) {
      drifts.push({ i, drift, label: label(replay[i]), y: after.y, scrollTop: after.scrollTop, distance: after.distance, jump: after.jumpVisible })
      console.log(`  DRIFT ${drift > 0 ? "+" : ""}${drift}px  after record ${i}: ${label(replay[i])}  (y ${lastY}→${after.y}, scrollTop ${after.scrollTop}, distance ${after.distance}, jump=${after.jumpVisible})`)
      lastY = after.y
    }
  }

  m = await probe(anchorKey)
  await page.screenshot({ path: join(shotDir, `replay-${parkTarget}-1-final.png`) })
  check(`replaying ${replay.length} REAL records never moved the reader`, drifts.length === 0, `${drifts.length} drifting appends${vanished ? `; anchor row left the render window after ${vanished}` : ""}`)
  check("the reader is still detached at the end", m.jumpVisible, `jump=${m.jumpVisible} distance=${m.distance}`)
  check("no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "))
  if (drifts.length) {
    console.log(`\nthe ${Math.min(drifts.length, 12)} first drifting appends:`)
    for (const d of drifts.slice(0, 12)) console.log(`  #${d.i} ${d.drift > 0 ? "+" : ""}${d.drift}px  ${d.label}  distance=${d.distance} jump=${d.jump}`)
  }
  console.log(`\nscreenshots → ${shotDir}/replay-${parkTarget}-*.png`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
