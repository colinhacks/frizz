// END-TO-END: does a worker that REST S with a live background shell actually reach the rail as a
// running-band row wearing the pulsing dot?
//
// The fixture pages set `awaitingBackground` by hand, which proves the CLIENT renders a flag — not that
// the flag ever gets set. The seam this closes is the whole chain: a real Bash launch with
// `run_in_background: true` in a real transcript → the REAL tailer's bgShellViews → the REAL
// board.deriveAwaitingBackground / deriveNeedsYou → the pushed snapshot → groups.ts banding → the glyph.
// Every link there is a place the change could be right in isolation and wrong in the app.
//
// It simulates the worker rather than dispatching a live provider (the sandbox HOME hides the keychain,
// so a real `claude` cannot authenticate) — but everything DOWNSTREAM of the transcript is the shipped
// code path, which is exactly the part under test.
//
// Usage: nub scripts/verify-rail-background-band.mjs --url=http://127.0.0.1:4931/ --home=/tmp/frizz-adhoc-home-X
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url")
const home = opt("home")
const shots = opt("shots", "/tmp/rail-shots")
if (!url || !home) {
  console.error("usage: nub scripts/verify-rail-background-band.mjs --url= --home=  (both from the adhoc-stack json line)")
  process.exit(1)
}

// UNIQUE PER RUN, and this is not cosmetic. The tailer keeps a durable per-sessionId cache — including
// the RETIRED-child ring — so a fixture that reuses an id inherits whatever the last run left behind.
// A first run whose ack text was wrong retired the control's child; every re-run after the fix then
// still read zero sub-agents, and the failure looked like the code rather than the leftovers.
const RUN = Date.now().toString(36).slice(-6)
const SLUG = `preview-server-e2e-${RUN}`
const SESSION_ID = `e2e11111-2222-3333-4444-${RUN.padStart(12, "0")}`
const THREAD_NAME = `frizz-${SLUG}`
// THE NEGATIVE CONTROL, and it is not optional: the maintainer scoped this mark with "this should not
// show up if there are sub-agents". A pass on the shell case alone would not distinguish "the dot
// appears for a live shell" from "the dot appears for any live background work" — the exact thing the
// scope forbids. So a second real session rests on a real dispatched CHILD and must keep the spinner.
const CTRL_SLUG = `subagent-control-e2e-${RUN}`
const CTRL_SESSION_ID = `e2e99999-8888-7777-6666-${RUN.padStart(12, "0")}`
const CTRL_THREAD_NAME = `frizz-${CTRL_SLUG}`
const failures = []

// The sandbox project dir the stack created, and the Claude transcript dir keyed by the project's cwd
// slug. Both are discovered rather than guessed: the stack picks the project id, and the slug is the
// project dir with every non-alphanumeric turned into a dash (Claude Code's own convention).
const sandbox = resolveSandboxDb(home)
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const db = new DatabaseSync(sandbox.db)
const projectDir = process.cwd()
const cwdSlug = projectDir.replace(/[^a-zA-Z0-9]/g, "-")
const transcriptDir = join(home, ".claude", "projects", cwdSlug)

const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()
const recFor = (sessionId) => (o) => JSON.stringify({ sessionId, cwd: projectDir, version: "2.0.0", ...o }) + "\n"
const rec = recFor(SESSION_ID)

try {
  mkdirSync(transcriptDir, { recursive: true })
  const jsonl = join(transcriptDir, `${SESSION_ID}.jsonl`)

  // 1. The transcript: a user turn, an assistant turn that LAUNCHES a background shell, its tool
  //    result, then the assistant coming to REST. This is the exact shape the rule is about — the
  //    worker has stopped, the shell has not.
  writeFileSync(jsonl, "")
  appendFileSync(jsonl, rec({ type: "user", timestamp: at(-60_000), message: { role: "user", content: "Wire up the preview server" } }))
  appendFileSync(jsonl, rec({
    type: "assistant",
    timestamp: at(-50_000),
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_bg_preview",
        name: "Bash",
        input: { command: "nub run dev --host", description: "Starting the preview server", run_in_background: true },
      }],
    },
  }))
  appendFileSync(jsonl, rec({
    type: "user",
    timestamp: at(-49_000),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg_preview", content: "Command running in background with ID: bash_1" }] },
  }))
  // The REST — a plain text turn with a stop reason, no fence. Bare rest is the case the rule targets.
  appendFileSync(jsonl, rec({
    type: "assistant",
    timestamp: at(-10_000),
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "The preview server is up on port 5173. Watching it." }] },
  }))

  // 2. The session row that binds slug → transcript. The sanctioned fixture write: the row IS
  //    the fixture, and everything read off it afterwards is the real pipeline.
  db.prepare(`INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, state, permission_mode)
              VALUES (${sessionVals}?, ?, ?, ?, ?, 'claude', 'open', 'default')`)
    .run(SLUG, SESSION_ID, THREAD_NAME, at(-70_000), "Wire up the preview server")

  // 3b. THE CONTROL — the same rest, but on a dispatched Agent instead of a Bash. Everything else about
  //     these two threads is identical, so whatever differs on the rail is the sub-agent carve-out and
  //     nothing else.
  const ctrlRec = recFor(CTRL_SESSION_ID)
  const ctrlJsonl = join(transcriptDir, `${CTRL_SESSION_ID}.jsonl`)
  writeFileSync(ctrlJsonl, "")
  appendFileSync(ctrlJsonl, ctrlRec({ type: "user", timestamp: at(-60_000), message: { role: "user", content: "Audit the broker crash paths" } }))
  appendFileSync(ctrlJsonl, ctrlRec({
    type: "assistant",
    timestamp: at(-50_000),
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_agent_audit",
        name: "Agent",
        input: { description: "Tracing every broker exit", prompt: "trace them", subagent_type: "frizz:opus-high", run_in_background: true },
      }],
    },
  }))
  appendFileSync(ctrlJsonl, ctrlRec({
    type: "user",
    timestamp: at(-49_000),
    // The REAL background-launch ack. tailer.LAUNCH_ACK_RE is what keeps a dispatched child tracked; any
    // other tool_result text is read as the terminal signal and RETIRES the child on the spot. A
    // plausible-looking invented string ("Agent running in background with ID: …") therefore produced a
    // control with zero live sub-agents — an instrument failure that reads exactly like the carve-out
    // working. Replicate production text verbatim here.
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_agent_audit", content: "Async agent launched successfully. You'll be notified when it finishes." }] },
  }))
  appendFileSync(ctrlJsonl, ctrlRec({
    type: "assistant",
    timestamp: at(-10_000),
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Dispatched the audit; waiting on it." }] },
  }))
  db.prepare(`INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, state, permission_mode)
              VALUES (${sessionVals}?, ?, ?, ?, ?, 'claude', 'open', 'default')`)
    .run(CTRL_SLUG, CTRL_SESSION_ID, CTRL_THREAD_NAME, at(-70_000), "Audit the broker crash paths")

  // 3. Let the tailer notice. It watches the transcript dir, but a row's runtime is only re-derived on
  //    a tick, so a brand-new session reads as "exited" until that turns over. Wait past it — at 6s the
  //    second session was still landing with no children, which looks exactly like the carve-out failing.
  await new Promise((r) => setTimeout(r, 15_000))

  // 4. Read the SERVER's own board — before any browser is involved, so a client-side pass cannot mask
  //    a server that never set the flag.
  const { createRpcClient } = await import("./lib/rpc-client.mjs")
  const api = createRpcClient(url)
  await api.waitForHealth()
  const board = await api.query("board")
  const thread = board.threads.find((t) => t.id === SLUG)
  if (!thread) {
    failures.push(`the board never surfaced ${SLUG} — the tailer did not pick up the fixture session`)
  } else {
    const shells = thread.bgShells ?? []
    console.log(`      runtime=${thread.runtime}  needsYou=${thread.needsYou}  awaitingBackground=${thread.awaitingBackground}  bgShells=${shells.length} [${shells.map((s) => `${s.label}:${s.state}`).join(", ")}]`)
    if (thread.runtime !== "turn-idle") failures.push(`the worker did not read as rested (runtime=${thread.runtime})`)
    if (!shells.some((s) => s.state === "running")) failures.push("the tailer tracked no running background shell")
    if (thread.awaitingBackground !== true) failures.push("the server did not derive awaitingBackground for a rested thread with a live shell")
    // EXCUSED FROM THE QUEUE (maintainer 2026-08-01: "if something is listed as currently running, then
    // it should never show up in the queue"). The row goes in the running band, so the card must be gone
    // — the two surfaces are mutually exclusive, and the server is the single place that decides it.
    if (thread.needsYou !== false) failures.push("a thread resting on a live shell must be excused from the queue (needsYou false)")
  }

  const control = board.threads.find((t) => t.id === CTRL_SLUG)
  if (!control) {
    failures.push(`the board never surfaced ${CTRL_SLUG} — the control session did not tail`)
  } else {
    const kids = control.subAgents ?? []
    console.log(`      control: runtime=${control.runtime}  subAgents=${kids.length} [${kids.map((s) => `${s.label}:${s.state}`).join(", ")}]`)
    if (!kids.some((s) => s.state === "running")) failures.push("the control has no running sub-agent — it cannot prove the carve-out")
  }

  // 5. Now the rail itself, in a real browser against the real board.
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  try {
    const page = await browser.newPage()
    const pageErrors = []
    page.on("pageerror", (e) => pageErrors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) pageErrors.push(m.text()) })
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 })
    await page.waitForSelector(`[data-sidebar-item="${SLUG}"]`, { timeout: 20_000 })
    await page.waitForSelector(`[data-sidebar-item="${CTRL_SLUG}"]`, { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 1500))

    const read = (slug) => page.evaluate((s) => {
      const row = document.querySelector(`[data-sidebar-item="${s}"]`)
      return {
        glyph: row?.querySelector("[data-rail-glyph]")?.getAttribute("data-rail-glyph") ?? null,
        hasDot: !!row?.querySelector(".frizz-rail-dot"),
        hasSpinner: !!row?.querySelector("svg animate"),
      }
    }, slug)
    const ctrl = await read(CTRL_SLUG)
    console.log(`      control rail: glyph=${ctrl.glyph}  dot=${ctrl.hasDot}  spinner=${ctrl.hasSpinner}`)
    if (ctrl.hasDot) failures.push('a thread resting on a SUB-AGENT is showing the dot — "this should not show up if there are sub-agents"')
    if (ctrl.glyph !== "working") failures.push(`the control resolved "${ctrl.glyph}", not "working" — a dispatched child is real motion and must keep the spinner`)
    if (!ctrl.hasSpinner) failures.push("the control lost its spinner")

    // THE REPORT THIS CLOSES (maintainer 2026-08-01): "even though the thread remains in the active
    // running rail, its card shows up in the queue". Assert the ABSENCE on the real queue surface, not
    // just the `needsYou` bit that feeds it — the bit and the render are two things, and it was the
    // render the maintainer saw.
    const cards = await page.evaluate((slug) => ({
      mine: !!document.querySelector(`[data-queue-card="${slug}"]`),
      total: document.querySelectorAll("[data-queue-card]").length,
    }), SLUG)
    console.log(`      queue: card for this thread=${cards.mine}  cards on the board=${cards.total}`)
    if (cards.mine) failures.push("the thread is in the running band AND has a queue card — the exact pair that must not happen")

    const seen = await page.evaluate((slug) => {
      const row = document.querySelector(`[data-sidebar-item="${slug}"]`)
      const mark = row?.querySelector("[data-rail-glyph]")
      // The running band is everything before the <hr> the Sidebar draws between the two bands; a row
      // AFTER that rule has dropped into the queue-ordered rested band.
      const rail = document.querySelector("[data-sidebar-rail]")
      const rule = rail?.querySelector("hr")
      const inRunningBand = !!(row && rule && (row.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING))
      return {
        glyph: mark?.getAttribute("data-rail-glyph") ?? null,
        hasDot: !!row?.querySelector(".frizz-rail-dot"),
        hasSpinner: !!row?.querySelector("svg animate"),
        inRunningBand,
      }
    }, SLUG)
    console.log(`      rail: glyph=${seen.glyph}  dot=${seen.hasDot}  spinner=${seen.hasSpinner}  runningBand=${seen.inRunningBand}`)
    if (seen.glyph !== "background") failures.push(`the rail resolved "${seen.glyph}", not "background"`)
    if (!seen.hasDot) failures.push("the row is not painting the pulsing dot")
    if (seen.hasSpinner) failures.push("the row is STILL spinning — the whole point is that a rested thread stops claiming motion")
    if (!seen.inRunningBand) failures.push("the row dropped below the band rule into the rested band")

    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: join(shots, "rail-e2e-full-board.png") })
    const rail = await page.$("[data-sidebar-rail]")
    await rail.screenshot({ path: join(shots, "rail-e2e-real-board.png") })

    // THE OTHER HALF of removing the queue card: with no card, the awaiting-background banner on the
    // thread page is the ONLY place this state is stated in words. If it were missing too, opening the
    // row would show a transcript that simply ends at rest — the "reads as if the agent died" failure of
    // 2026-07-29, which is precisely what that card exists to prevent. So assert it is still there.
    await page.goto(`${url}thread/${SLUG}`, { waitUntil: "networkidle2", timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 2000))
    const banner = await page.evaluate(() => {
      const el = document.querySelector("[data-awaiting-background]")
      return { present: !!el, text: (el?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 120) }
    })
    console.log(`      thread page: awaiting-background card=${banner.present}  "${banner.text}"`)
    if (!banner.present) failures.push("the awaiting-background card is gone from the thread page too — with no queue card either, this state is now stated NOWHERE")
    await page.screenshot({ path: join(shots, "thread-page-awaiting-bg.png") })
    console.log(`      shot → ${join(shots, "rail-e2e-real-board.png")}`)
    if (pageErrors.length) failures.push(`console/page errors: ${pageErrors.join(" | ")}`)
  } finally {
    await browser.close()
  }
} finally {
  // Tear the fixture down: the row and the transcript. The temp HOME goes with the stack.
  for (const slug of [SLUG, CTRL_SLUG]) { try { db.prepare("DELETE FROM session WHERE slug = ?").run(slug) } catch {} }
}

console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\na real rested-with-a-live-shell thread reaches the rail in the running band wearing the dot and not spinning — and the sub-agent control beside it keeps its spinner")
process.exit(failures.length ? 1 : 0)
