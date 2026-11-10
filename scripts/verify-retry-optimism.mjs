// Does clicking Retry on a STALLED row acknowledge the click AT ALL?
//
// A stalled row (its process exited) wears the yellow [!] and carries the inline Retry verb. Retry is
// an ordinary follow-up — it starts a turn exactly like a steer — but it used to go through a
// lib/retrySession that called rpc.followUp DIRECTLY instead of the eager path, so it never marked the
// steer, never wrote the optimistic bubble, and never joined the per-slug send chain. The row kept its
// [!] and its rested-band slot for the whole server round-trip, with a toast as the only feedback.
//
// TIMING IS MEASURED IN-PAGE, on a rAF loop, with the click issued from the same task as t0. A
// Node-side polling loop cannot resolve this: one CDP evaluate round-trip on a loaded machine is
// ~1.3s, the same order as the bug itself, so it reports "instant" and "two seconds" identically.
//
//   node scripts/verify-retry-optimism.mjs <url> <unused> [slug]
import { launchHeadless } from "./lib/headless-browser.mjs"

const [url, _socket, slug = "worker-6"] = process.argv.slice(2)
if (!url) {
  console.error("usage: node verify-retry-optimism.mjs <url> <unused> [slug]")
  process.exit(1)
}

// The row's rail state: which band it sits in, its index, and which mark it wears.
const READ_ROW = (s) => `(() => {
  const row = document.querySelector('[data-sidebar-item="${s}"]')
  if (!row) return null
  const rail = document.querySelector('[data-sidebar-rail]')
  let band = 'running', i = 0
  for (const c of rail.children) {
    if (c.tagName === 'HR') { band = 'rested'; continue }
    const r = c.querySelector(':scope > [data-sidebar-item]')
    if (!r) continue
    if (r.dataset.sidebarItem === '${s}') return {
      band, idx: i,
      spinner: !!row.querySelector('svg[data-box-spinner]'),
      glyph: (row.querySelector('[aria-hidden].font-bold')?.textContent ?? '').trim() || null,
    }
    i++
  }
  return null
})()`

const browser = await launchHeadless()
const errs = []
try {
  const p = await browser.newPage()
  await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 })
  p.on("pageerror", (e) => errs.push(String(e)))
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()) })
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await p.waitForSelector(`[data-sidebar-item="${slug}"]`, { timeout: 60_000 })

  // Make it STALL: kill the pane out from under the row. deriveRuntime then reads "exited".
  let stalled = null
  for (let i = 0; i < 60; i++) {
    stalled = await p.evaluate(READ_ROW(slug))
    if (stalled?.glyph === "!") break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (stalled?.glyph !== "!") throw new Error("the row never reached the stalled [!] state")
  await p.screenshot({ path: "/tmp/audit/50-stalled.png" })

  // Record every change on a rAF loop, in page context, from the exact task that issues the click.
  const log = await p.evaluate(`new Promise((resolve) => {
    const read = () => ${READ_ROW(slug)}
    const entries = []
    const t0 = performance.now()
    entries.push({ at: 0, ...read() })
    let last = JSON.stringify(read())
    document.querySelector('[data-sidebar-retry="${slug}"]').click()
    const tick = () => {
      const now = read()
      const key = JSON.stringify(now)
      if (key !== last) { last = key; entries.push({ at: Math.round(performance.now() - t0), ...now }) }
      if (performance.now() - t0 > 6000) return resolve(entries)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })`)
  await p.screenshot({ path: "/tmp/audit/51-after-retry-click.png" })

  const working = log.find((e) => e.at > 0 && e.spinner === true && e.band === "running")
  console.log(JSON.stringify({
    stalledBefore: stalled,
    // The single number this harness exists for: click → the row reads as working.
    msToWorkingRow: working?.at ?? null,
    transitions: log,
    pageErrors: errs,
  }, null, 2))
  if (!working) { console.error("FAIL: the row never painted as working"); process.exitCode = 1 }
  else if (working.at > 100) { console.error(`FAIL: ${working.at}ms to acknowledge the click`); process.exitCode = 1 }
  else console.error(`PASS: the row reads as working ${working.at}ms after the click`)
} finally {
  await browser.close()
}
