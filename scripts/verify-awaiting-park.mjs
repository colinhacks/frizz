// End-to-end verification for the awaiting card's "Confirm snooze" button.
//
// The bug: the `awaiting` fence grammar (isValidAwaitingTimer) admits instants the durable snooze
// grammar (SnoozeUntil) rejects — no milliseconds, no seconds, an explicit numeric offset. The park
// button POSTed the RAW hint, so a fence written the way the worker contract documents it
// (`timer: 2026-07-24T17:00:00Z`) failed zod validation at the RPC boundary and the operator saw
// "Couldn't snooze: RPC setThreadSnooze failed" — a message naming nothing.
//
// This drives the REAL app in a REAL browser against a REAL disposable stack: click the button the
// human clicks, then read the DURABLE row the server wrote. Includes the negative control (the raw
// fence form must still be REJECTED at the boundary, with a message a human can read) so the fix is
// proven to be normalization at the seam, not a loosened storage contract.
//
// Usage: node scripts/verify-awaiting-park.mjs --url=http://127.0.0.1:4931 --slug=… --db=/abs/ui.db
import { execFileSync } from "node:child_process"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { url, slug, db, shots = "/tmp" } = flags
if (!url || !slug || !db) {
  console.error("usage: node verify-awaiting-park.mjs --url= --slug= --db= [--shots=/tmp]")
  process.exit(1)
}

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const snoozedUntil = () =>
  execFileSync("sqlite3", [db, `SELECT COALESCE(snoozed_until,'') FROM session WHERE slug='${slug}'`]).toString().trim()

// Negative control: the durable grammar must STILL reject the raw fence shape — the fix normalizes
// upstream, it does not widen what storage accepts — and must say so in a string the UI can render.
const raw = await fetch(`${url}/rpc/setThreadSnooze`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: url },
  body: JSON.stringify({ slug, until: "2026-07-24T17:00:00Z" }),
})
const rawBody = await raw.json()
check("raw fence instant is still rejected by the durable snooze grammar", raw.status === 400, `HTTP ${raw.status}`)
check("its rejection is a readable string, not an unrenderable object", typeof rawBody.error === "string", JSON.stringify(rawBody.error))
check("that string names the offending field", /^until: /.test(String(rawBody.error)), String(rawBody.error))
check("nothing was persisted by the rejected call", snoozedUntil() === "", snoozedUntil())

const browser = await launchHeadless()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
  const errors = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${url}?thread=${slug}`, { waitUntil: "networkidle2", timeout: 30000 })

  const button = await page.waitForSelector('[aria-label="Confirm snooze"]', { timeout: 15000 })
  check("the awaiting card offers the park button for a future timer hint", Boolean(button))
  await page.screenshot({ path: `${shots}/awaiting-park-before.png` })

  await button.click()
  // The toast is the operator's entire signal that the park landed; wait for either outcome so a
  // failure is reported as the failure text rather than a bare timeout.
  await page.waitForFunction(
    () => /Snoozed|Couldn.t snooze|failed/i.test(document.body.innerText),
    { timeout: 15000 },
  )
  const toast = await page.evaluate(
    () => (document.body.innerText.match(/(Couldn.t snooze[^\n]*|Snoozed · [^\n]*)/) || [""])[0],
  )
  check("the toast confirms the snooze instead of reporting an RPC failure", /^Snoozed · /.test(toast), toast)
  await page.screenshot({ path: `${shots}/awaiting-park-after.png` })

  // The durable row is the authority — a toast alone would not prove the server persisted anything.
  const persisted = snoozedUntil()
  check("the fence's instant is persisted, canonicalized to the storage grammar", persisted === "2026-07-24T17:00:00.000Z", persisted)
  check("no console errors during the park", errors.length === 0, errors.join(" | "))
} finally {
  await browser.close()
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
