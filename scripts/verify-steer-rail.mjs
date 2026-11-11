// What the operator FEELS when they steer a thread: the rail row's spinner vs. the rail row's
// POSITION. Both are the same claim ("this thread is working again"), and they are supposed to land
// together — the reported bug is that the spinner starts instantly while the row sits in the rested
// (queue-ordered) band for seconds before hopping into the running band.
//
// This drives the REAL app in a real browser against a seeded adhoc stack: it opens the thread in the
// board's pane, types into its prompt box, presses Enter, and then samples the rail every 40ms recording (a) whether the
// row's indicator is the animated BoxSpinner and (b) which band the row is in (the Active section's
// one direct-child <hr> separates running from rested). It then appends the JSONL records a real
// Claude Code writes when it picks the follow-up up, so the SERVER's own "running" verdict lands
// mid-measurement and the report can show whether the optimistic position matched the truth (no
// second jump) or merely preceded it.
//
//   node scripts/verify-steer-rail.mjs <url> <tempHome> [slug] [sessionId] [outDir]
import { appendFileSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { launchHeadless } from "./lib/headless-browser.mjs"

const [url, home, slug = "worker-5", sessionId = "00000005-2222-3333-4444-555555555555", outDir = "/tmp/steer-rail"] =
  process.argv.slice(2)
if (!url || !home) {
  console.error("usage: node verify-steer-rail.mjs <url> <tempHome> [slug] [sessionId] [outDir]")
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

// The rail probe, evaluated in page context on every sample. `band` keys on the Active section's one
// DIRECT-child <hr> (Snoozed/Done each nest theirs inside a wrapper), which is exactly the rule the
// Sidebar renders by.
const PROBE = `(() => {
  const rail = document.querySelector('[data-sidebar-rail]')
  if (!rail) return { ready: false }
  const order = []
  let seenHr = false
  for (const child of rail.children) {
    if (child.tagName === 'HR') { seenHr = true; continue }
    const row = child.querySelector?.('[data-sidebar-item]')
    if (!row) continue
    order.push({
      id: row.dataset.sidebarItem,
      band: seenHr ? 'rested' : 'running',
      spinner: !!row.querySelector('svg[data-box-spinner]'),
    })
  }
  return {
    ready: true,
    order,
    pane: document.querySelector('[data-pane-thread] [data-thread-surface]')?.getAttribute('data-thread-surface') ?? null,
  }
})()`

const jsonlDir = join(home, ".claude", "projects", readdirSync(join(home, ".claude", "projects"))[0])
const jsonl = join(jsonlDir, `${sessionId}.jsonl`)

const browser = await launchHeadless()
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 })
  await page.waitForSelector(`[data-sidebar-item="${slug}"]`, { timeout: 20_000 })
  await new Promise((r) => setTimeout(r, 2500)) // let the board settle

  const before = await page.evaluate(PROBE)
  await page.screenshot({ path: join(outDir, "10-before-steer.png") })

  await page.click(`[data-sidebar-item="${slug}"]`)
  const composer = `[data-pane-thread] [data-thread-surface="${slug}"] textarea`
  await page.waitForSelector(composer, { timeout: 10_000 })
  await page.click(composer)
  await page.type(composer, "keep going — check the narrow viewport too")

  // The JSONL a real Claude Code writes when it accepts and starts the turn. Fired on a timer from the
  // moment of Enter so the SERVER's verdict lands mid-measurement, exactly as it would in production.
  const TRUTH_DELAY_MS = 1200
  let truthAt = null
  const samples = []
  const t0 = performance.now()
  await page.keyboard.press("Enter")
  const truthTimer = setTimeout(() => {
    appendFileSync(jsonl, JSON.stringify({
      type: "user",
      timestamp: new Date().toISOString(),
      message: { content: "keep going — check the narrow viewport too" },
    }) + "\n" + JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { id: "steer-turn", content: [{ type: "tool_use", name: "Read", input: { file_path: "/src/x.tsx" } }], stop_reason: "tool_use" },
    }) + "\n")
    truthAt = performance.now() - t0
  }, TRUTH_DELAY_MS)

  let shot400 = false
  for (let i = 0; i < 400; i++) {
    const at = performance.now() - t0
    const probe = await page.evaluate(PROBE)
    const row = probe.order?.find((r) => r.id === slug)
    samples.push({ at: +at.toFixed(0), band: row?.band ?? null, spinner: row?.spinner ?? null, index: probe.order?.findIndex((r) => r.id === slug) ?? -1 })
    if (!shot400 && at > 400) { shot400 = true; await page.screenshot({ path: join(outDir, "11-t400ms.png") }) }
    if (at > 9000) break
    await new Promise((r) => setTimeout(r, 40))
  }
  clearTimeout(truthTimer)
  await page.screenshot({ path: join(outDir, "12-t9s.png") })
  const after = await page.evaluate(PROBE)

  const firstWhere = (pred) => samples.find(pred)?.at ?? null
  console.log(JSON.stringify({
    slug,
    truthAppendedAtMs: truthAt === null ? null : +truthAt.toFixed(0),
    before: { order: before.order, pane: before.pane },
    msToSpinner: firstWhere((s) => s.spinner === true),
    msToRunningBand: firstWhere((s) => s.band === "running"),
    msToRailTop: firstWhere((s) => s.index === 0),
    // Did the row settle ONCE, or hop again when server truth landed?
    bandTimeline: samples.filter((s, i) => i === 0 || s.band !== samples[i - 1].band).map((s) => ({ at: s.at, band: s.band })),
    indexTimeline: samples.filter((s, i) => i === 0 || s.index !== samples[i - 1].index).map((s) => ({ at: s.at, index: s.index })),
    after: { order: after.order, pane: after.pane },
    pageErrors: errors,
  }, null, 2))
} finally {
  await browser.close()
}
