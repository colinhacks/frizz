// The built-in to-do list must render as a CHECKLIST card, not as a wall of task prose.
//
// Claude Code's TaskUpdate is a delta (`{taskId:"3", status:"completed"}`) whose only long field is the
// model's `description`, so the generic tool card promoted a 600-character maintainer ruling to the
// card's title — three consecutive updates read as three walls of prose with no hint of what changed
// (maintainer 2026-07-29). The server now folds the whole list across the transcript and this drives
// the REAL pipeline for it — JSONL → tailer → transcript projection → ChatView → TodoBlock.
//
// Asserted here and nowhere else: only the calls that ENUMERATE become checklists (TaskList's result,
// codex's update_plan, TodoWrite) while the per-task deltas stay ordinary cards titled by their change;
// no card is titled by its description; the counter and the in-progress headline are right; a long task
// wraps instead of clipping; and the checkbox glyph's INK sits on the optical centre of the text beside
// it (the alignment gate).
//
// Usage: nub scripts/verify-todo-render.mjs --port=4931 --home=/abs/temp-home [--shots=/abs/dir]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4931"))
const home = opt("home")
const cwd = opt("project", process.cwd())
const shots = opt("shots")
if (!home) throw new Error("--home=<stack temp HOME> is required (the adhoc stack prints it as `home`)")

const SLUG = "todo-render-check"
// A FRESH session id per run: the server caches the transcript projection PER SESSION, so a fixed id
// makes a re-run silently assert against the previous run's parse.
const SESSION_ID = randomUUID()
const now = new Date().toISOString()

// The description that used to BE the card title, verbatim in shape (long, quoted, prose).
const RULING = `MAINTAINER RULING: "Unconfined reads are not acceptable for this. That would be fatal to the entire build jail." So the restricted-token + low-IL fallback is DISQUALIFIED as a shipping posture — it leaves ~/.ssh, .npmrc, .aws readable. AppContainer is the only measured route to deny-by-default reads.`

const logDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(logDir, { recursive: true })
const base = { isSidechain: false, userType: "external", cwd, sessionId: SESSION_ID, version: "2.1.220", gitBranch: "main" }
const records = []
let n = 0
const push = (rec) => records.push({ ...base, ...rec, parentUuid: records.length ? records.at(-1).uuid : null, uuid: `0000000${++n}-0000-0000-0000-000000000000`.slice(-36), timestamp: now })
const user = (text) => push({ type: "user", message: { role: "user", content: text } })
const assistant = (text) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text }] } })
const toolCall = (id, name, input) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id, name, input }] } })
const toolResult = (id, content) => push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } })

const TASKS = [
  "Confine reads on Windows — unconfined is fatal",
  "Fix the coarse network grant on Linux and Windows",
  "Drop per-host on macOS and delete $downloads",
  // A subject longer than the card is wide. Agents write these constantly, and a row must WRAP (under its
  // own text, not under its checkbox) rather than clip against the card's overflow:hidden.
  "Reconcile the five parallel sandbox branches into sandbox/integration, then re-run the per-OS jail measurements on each host before the release cut",
]

user("Work through the build-jail defects.")
assistant("Setting up the list first.")
TASKS.forEach((subject, i) => {
  toolCall(`tc${i}`, "TaskCreate", { subject, description: RULING, activeForm: `Working on ${subject}` })
  toolResult(`tc${i}`, `Task #${i + 1} created successfully: ${subject}`)
})
assistant("List is up. Starting on the Windows read posture.")
toolCall("tu1", "TaskUpdate", { taskId: "1", status: "in_progress" })
toolResult("tu1", "Updated task #1 status")
toolCall("tu2", "TaskUpdate", { taskId: "1", status: "completed" })
toolResult("tu2", "Updated task #1 status")
// The delta that carries a fresh ruling — the description belongs in the body, never in the title.
toolCall("tu3", "TaskUpdate", { taskId: "3", status: "completed", description: RULING })
toolResult("tu3", "Updated task #3 status, description")
assistant("Two down. Here is where the list stands.")
toolCall("tl1", "TaskList", {})
const STANDING = ["completed", "in_progress", "completed", "pending"]
toolResult("tl1", TASKS.map((s, i) => `#${i + 1} [${STANDING[i]}] ${s}`).join("\n"))
assistant("Continuing with the remaining two.")

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

// ---- and a CODEX thread, because codex's to-do list is a different protocol on the same card ----
// `update_plan` ships the WHOLE plan every call, in two shapes: a direct function_call carrying JSON, and
// the JS-wrapper `tools.update_plan({...})` whose args are a JavaScript object literal (bare `step` key
// beside a quoted `"status"` key — JSON.parse cannot read it). Both must land on the identical TodoBlock,
// and only driving the real thread proves the projection reaches the card rather than merely producing
// the right shape in a unit test.
const CODEX_SLUG = "todo-render-codex"
const CODEX_SESSION = randomUUID()
const codexDir = join(home, ".codex", "sessions", "2026", "07", "29")
mkdirSync(codexDir, { recursive: true })
const PLAN = [
  "Read the review instructions and local overrides",
  "Inspect the PR context and the full diff",
  "Deliver severity-ordered findings",
]
const item = (payload) => JSON.stringify({ timestamp: now, type: "response_item", payload })
const codexRecords = [
  JSON.stringify({ timestamp: now, type: "session_meta", payload: { id: CODEX_SESSION, cwd, originator: "codex", cli_version: "0.144.1" } }),
  item({ type: "message", role: "user", content: [{ type: "input_text", text: "Review the billing migration." }] }),
  // (a) the direct function_call form, with an explanation → the note pane
  item({ type: "function_call", name: "update_plan", call_id: "cx1", arguments: JSON.stringify({
    explanation: "Instructions are loaded; the target is a large billing/schema/runtime migration.",
    plan: PLAN.map((step, i) => ({ step, status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending" })),
  }) }),
  item({ type: "function_call_output", call_id: "cx1", output: JSON.stringify({ output: "Plan updated", success: true }) }),
  item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Diff inspected. Closing out the plan." }] }),
  // (b) the JS-wrapper form, mixed quoting, verbatim in shape from a real rollout
  item({ type: "custom_tool_call", name: "exec", call_id: "cx2", status: "completed",
    input: `const r = await tools.update_plan({plan:[${PLAN.map((step, i) => `{step:${JSON.stringify(step)},${i === 2 ? "status" : '"status"'}:${JSON.stringify(i === 2 ? "in_progress" : "completed")}}`).join(",")}]});text(String(r));` }),
  item({ type: "custom_tool_call_output", call_id: "cx2", output: "Script completed\nWall time 0.0 seconds\nOutput:\n{}" }),
  item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Findings are next." }] }),
]
writeFileSync(join(codexDir, `rollout-2026-07-29T12-00-00-${CODEX_SESSION}.jsonl`), codexRecords.join("\n") + "\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const seed = (slug, sessionId, title, backend, model) => {
  const threadName = `frizz-${slug}`
  execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${slug}';`])
  execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
    (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
    VALUES (${sessionVals}'${slug}', '${sessionId}', '${threadName}', '${now}', '${title}', '${backend}', '${model}', 'high', 'default', 0, 0, 0, 0, 0, 0);`])
  return threadName
}
const threadName = seed(SLUG, SESSION_ID, "Todo render check", "claude", "opus")
const codexThreadName = seed(CODEX_SLUG, CODEX_SESSION, "Todo render codex", "codex", "gpt-5.6-terra")

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
  await page.setViewport({ width: 1400, height: 1100, deviceScaleFactor: 2 })
  await page.goto(`http://127.0.0.1:${port}/thread/${SLUG}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-todo-card]", { timeout: 20_000 })
  // Tool bands past 4 calls collapse behind an "N tool calls" toggle; open every one so all the cards mount.
  for (const toggle of await page.$$('button[aria-label*="tool calls"]')) {
    if ((await toggle.evaluate((el) => el.getAttribute("aria-expanded"))) === "false") await toggle.click()
  }
  await page.waitForFunction(() => document.querySelectorAll("[data-todo-card]").length >= 1, { timeout: 10_000 })

  const cardsSeen = await page.evaluate(() =>
    [...document.querySelectorAll("[data-todo-card]")].map((card) => {
      const header = card.querySelector(".frizz-bash-header")
      return { text: header.textContent.replace(/\s+/g, " ").trim(), marks: header.querySelectorAll("svg.frizz-todo-mark").length }
    }))
  // ONE checklist card in this thread: the TaskList. The four creates and three updates carry no list, so
  // they must NOT be promoted into to-do cards — inventing a list for them is exactly what this doesn't do.
  check(cardsSeen.length === 1, "only the enumerating call becomes a checklist card", `saw ${cardsSeen.length}: ${JSON.stringify(cardsSeen.map((c) => c.text))}`)
  // "Todos", not "TODOS": the caps are CSS (petite-caps), so textContent carries the authored case.
  check(cardsSeen[0].text.startsWith("Todos"), "and it carries the Todos label", cardsSeen[0].text)
  check(cardsSeen[0].text.includes("2/4"), "its header counts the list it returned", cardsSeen[0].text)
  check(cardsSeen[0].text.includes("Fix the coarse network grant"), "and headlines the step IN PROGRESS", cardsSeen[0].text)

  // The deltas: ordinary cards, titled by the CHANGE — and never by the 600-char description.
  const deltas = await page.evaluate(() =>
    [...document.querySelectorAll(".frizz-bash")].map((c) => {
      const h = c.querySelector(".frizz-bash-header")
      return { label: h?.querySelector(".frizz-bash-label")?.textContent, text: h?.textContent.replace(/\s+/g, " ").trim() }
    }).filter((c) => c.label && /^Task(Create|Update|Get)$/.test(c.label)))
  check(deltas.length === 7, "every delta renders as an ordinary tool card", `saw ${deltas.length}`)
  check(!deltas.some((d) => d.text.includes("MAINTAINER RULING")), "NO card is titled by its task description",
    deltas.find((d) => d.text.includes("MAINTAINER RULING"))?.text)
  check(deltas.some((d) => d.text.includes("Confine reads on Windows")), "a create is titled by its subject",
    JSON.stringify(deltas.map((d) => d.text).slice(0, 4)))
  check(deltas.some((d) => d.text.includes("#1 \u2192 completed")) && deltas.some((d) => d.text.includes("#1 \u2192 in progress")),
    "a status-only update is titled by the change it makes, in sentence case",
    JSON.stringify(deltas.map((d) => d.text)))
  check(!cardsSeen.some((c) => c.marks > 1), "the checklist header carries at most one status glyph", JSON.stringify(cardsSeen.map((c) => c.marks)))

  // ---- the checklist body ----
  const listCard = (await page.$$("[data-todo-card]"))[0]
  await listCard.$eval(".frizz-bash-header", (el) => el.click())
  await page.waitForSelector("[data-todo-card] .frizz-todo-list", { timeout: 10_000 })
  const body = await page.evaluate(() =>
    [...document.querySelectorAll("[data-todo-card] .frizz-todo-list .frizz-todo-row")].map((row) => ({
      text: row.textContent.replace(/\s+\u2014\s+(to do|in progress|done)$/, "").trim(),
      current: row.dataset.current === "true",
      status: row.textContent.match(/\u2014\s+(to do|in progress|done)$/)?.[1],
    })))
  check(body.length === 4, "the body lists every task the result enumerated, one row each", `saw ${body.length}`)
  check(body[0].text.startsWith("Confine reads on Windows"), "the rows keep the order the result gave", body.map((r) => r.text).join(" | "))
  check(body.filter((r) => r.status === "done").length === 2 && body.filter((r) => r.status === "in progress").length === 1
    && body.filter((r) => r.status === "to do").length === 1, "each row carries its own status", JSON.stringify(body.map((r) => r.status)))
  check(body.filter((r) => r.current).length === 1 && body.find((r) => r.current)?.status === "in progress",
    "the in-progress row is the tinted one, and it is what the header headlines", JSON.stringify(body))

  // The description is still REACHABLE — as the delta card's expandable body, just not as its title.
  const noteCard = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".frizz-bash")].find((c) => c.querySelector(".frizz-bash-label")?.textContent === "TaskCreate"))
  await noteCard.asElement().$eval(".frizz-bash-header", (el) => el.click())
  await page.waitForFunction(() => [...document.querySelectorAll(".frizz-bash-output-body")].some((p) => p.textContent.includes("MAINTAINER RULING")), { timeout: 10_000 })
  check(true, "the description IS reachable, in the delta card's expandable body")

  // A row longer than the card WRAPS, and wraps under its own text — the checkbox keeps its column and the
  // continuation lines stay indented past it. `.frizz-bash` is overflow:hidden, so the failure mode is a
  // silently amputated task, with no ellipsis to admit it.
  const wrap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-todo-card] .frizz-todo-list .frizz-todo-row")]
    const long = rows.find((r) => r.textContent.includes("sandbox/integration"))
    const list = long.closest(".frizz-todo-list").getBoundingClientRect()
    const text = [...long.children].find((c) => c.tagName === "SPAN" && !c.classList.contains("sr-only"))
    const lines = [...(() => { const r = document.createRange(); r.selectNodeContents(text); return r.getClientRects() })()]
    const glyph = long.querySelector("svg").getBoundingClientRect()
    return {
      lines: lines.length,
      escapesRight: Math.round(Math.max(...lines.map((l) => l.right)) - list.right),
      indented: lines.every((l) => l.left >= glyph.right - 0.5),
      rowTallerThanOneLine: long.getBoundingClientRect().height > lines[0].height * 1.5,
    }
  })
  check(wrap.lines > 1 && wrap.rowTallerThanOneLine, "a task longer than the card wraps instead of clipping", JSON.stringify(wrap))
  check(wrap.escapesRight <= 0, "no wrapped line escapes the card", JSON.stringify(wrap))
  check(wrap.indented, "wrapped lines stay indented past the checkbox", JSON.stringify(wrap))

  // ---- ALIGNMENT GATE: every checkbox glyph's INK vs the ink of the text beside it ----
  // The instrument is the visual-review skill's routine verbatim, including its trap: a zero-size probe
  // appended to a FLEX container becomes a flex item and reports the line's centre, inflating a ~1px
  // error to ~3px. The text node is wrapped in its own inline span and probed INSIDE that. Each of the
  // three glyphs is measured separately, in BOTH contexts, because every glyph's ink differs.
  const measureInk = () => {
    const baselineOfTextNode = (node) => {
      const span = document.createElement("span")
      node.parentNode.insertBefore(span, node)
      span.appendChild(node)
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
      span.appendChild(probe)
      const baseline = probe.getBoundingClientRect().bottom
      const cs = getComputedStyle(span)
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`
      probe.remove()
      span.parentNode.insertBefore(node, span)
      span.remove()
      return { baseline, font }
    }
    // THE REFERENCE BAND, and why it is not the string's own ink box. The skill's routine measures the
    // actualBoundingBox of the specific text — exact for a DIGIT (uniform, no descender) but unstable for
    // prose: measured here, a row whose text has a descender ("…network grant…") reported 3.06px while a
    // row without one ("…unconfined is fatal") reported 1.88px, for the SAME glyph at the SAME size. A
    // per-row nudge is meaningless, so the glyph aligns to the string-INDEPENDENT band the eye reads as
    // "the line of text": baseline → cap height. `capBand` is that; `stringInk` is kept for contrast.
    const capBand = (font, baseline) => {
      const c = document.createElement("canvas").getContext("2d")
      c.font = font
      return { top: baseline - c.measureText("H").actualBoundingBoxAscent, bottom: baseline }
    }
    const inkOfText = (text, font, baseline) => {
      const c = document.createElement("canvas").getContext("2d")
      c.font = font
      const m = c.measureText(text)
      return { top: baseline - m.actualBoundingBoxAscent, bottom: baseline + m.actualBoundingBoxDescent }
    }
    const inkOfSvg = (svg) => {
      const rects = [...svg.querySelectorAll("path,rect,circle,ellipse,polyline,polygon,line")].map((g) => g.getBoundingClientRect())
      return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) }
    }
    const mid = (o) => (o.top + o.bottom) / 2
    const analyze = (holder, name) => {
      const svg = holder.querySelector("svg")
      const textEl = [...holder.querySelectorAll("span")].find((s) => !s.classList.contains("sr-only") && s.firstChild?.nodeType === 3)
      const node = [...textEl.childNodes].find((n) => n.nodeType === 3 && /\S/.test(n.textContent))
      const { baseline, font } = baselineOfTextNode(node)
      const band = capBand(font, baseline)
      const stringInk = inkOfText(node.textContent.trim(), font, baseline)
      const glyphInk = inkOfSvg(svg)
      return {
        glyph: name,
        fontSize: +parseFloat(getComputedStyle(textEl).fontSize).toFixed(1),
        glyphInkHeight: +(glyphInk.bottom - glyphInk.top).toFixed(2),
        // POSITIVE = the glyph's ink rides ABOVE the cap band's centre and must move DOWN this many px.
        nudgeDownPx: +(mid(band) - mid(glyphInk)).toFixed(2),
        vsStringInk: +(mid(stringInk) - mid(glyphInk)).toFixed(2),
      }
    }
    const card = document.querySelector("[data-todo-card]")
    const rows = [...card.querySelectorAll(".frizz-todo-list .frizz-todo-row")]
    const byStatus = (word) => rows.find((r) => r.textContent.trim().endsWith(word))
    // The header glyph aligns to the HEADLINE beside it, not to the petite-caps label (which carries its
    // own separate optical correction) — so measure inside the headline group specifically.
    return [
      analyze(byStatus("to do"), "row · pending"),
      analyze(byStatus("in progress"), "row · in progress"),
      analyze(byStatus("done"), "row · completed"),
      analyze(card.querySelector("[data-todo-headline]"), "header · current"),
    ]
  }
  // nowrap for the MEASUREMENT ONLY (the screenshots above are already taken, unaffected): a wrapped row
  // makes `baselineOfTextNode` report the LAST line's baseline while the glyph aligns to the first, which
  // read as an 18px error on the long task here and a 42px one at 2x. It is the instrument's blind spot,
  // not a defect in the row — the wrap itself is asserted above, at the real width.
  // ...and removed immediately after, by its own HANDLE. The screenshots are captured below, and a leaked
  // nowrap turns the long task into a clipped one in the evidence (it did — the shot showed "…per-OS ja"
  // against the card edge). Removing it by scanning `querySelectorAll("style")` for the text is NOT the
  // way: in dev, Vite injects the whole app CSS as a <style>, and diff.css contains both "frizz-todo-row"
  // and "nowrap" — that predicate deleted the entire stylesheet, which then showed up as a bogus
  // header-collision failure at 420px on an unstyled page.
  const nowrapTag = await page.addStyleTag({ content: ".frizz-todo-row,.frizz-bash-header [data-todo-headline]{white-space:nowrap}" })
  await new Promise((r) => setTimeout(r, 150))
  const align = await page.evaluate(measureInk)
  await nowrapTag.evaluate((el) => el.remove())
  await new Promise((r) => setTimeout(r, 150))
  for (const a of align) console.log(`      ink  ${a.glyph.padEnd(20)} text ${a.fontSize}px  glyph ink ${a.glyphInkHeight}px  nudge ${a.nudgeDownPx > 0 ? "+" : ""}${a.nudgeDownPx}px  (vs this string's own ink ${a.vsStringInk}px)`)
  // Sub-pixel is under the device grid; past ~0.3px the eye reads the glyph as riding high or low.
  const worst = align.reduce((w, a) => (Math.abs(a.nudgeDownPx) > Math.abs(w.nudgeDownPx) ? a : w))
  check(Math.abs(worst.nudgeDownPx) <= 0.3, "every checkbox's ink sits on the optical centre of its text",
    `worst: ${worst.glyph} off by ${worst.nudgeDownPx}px`)
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await (await page.$("[data-todo-card]")).screenshot({ path: join(shots, "todo-list.png") })
    const deltaShot = await page.evaluateHandle(() =>
      [...document.querySelectorAll(".frizz-bash")].find((c) => c.querySelector(".frizz-bash-label")?.textContent === "TaskCreate"))
    await deltaShot.asElement().screenshot({ path: join(shots, "todo-delta.png") })
    await page.screenshot({ path: join(shots, "todo-thread.png") })
    // The band at a narrow width: nothing may escape the card or collide with the counter.
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
    await new Promise((r) => setTimeout(r, 400))
    const narrow = await page.evaluate(() => {
      const card = document.querySelector("[data-todo-card]")
      const b = card.getBoundingClientRect()
      const head = card.querySelector(".frizz-bash-header").getBoundingClientRect()
      const right = card.querySelector(".frizz-bash-header > span:last-child").getBoundingClientRect()
      const left = card.querySelector(".frizz-bash-header > span:first-child").getBoundingClientRect()
      return { escapes: Math.round(head.right - b.right), collides: left.right > right.left + 1 }
    })
    check(narrow.escapes <= 1 && !narrow.collides, "the header holds at 420px — no escape, no collision", JSON.stringify(narrow))
    await (await page.$("[data-todo-card]")).screenshot({ path: join(shots, "todo-narrow.png") })
    await page.setViewport({ width: 1400, height: 1100, deviceScaleFactor: 2 })
    console.log(`      shots → ${shots}`)
  }

  // A correction in `em` is only worth writing if it TRACKS the font size, so re-measure at DOUBLE the
  // type — a px-equivalent correction doubles its error here (this gate is what caught the glyph being
  // pinned at `size={12}` while everything around it scaled).
  //
  // Runs LAST and on a FRESH LOAD: the injected type is never reverted, so anything measured or
  // photographed after it would be of a 24px card, not the real one (the screenshots above were briefly
  // captured at 24px for exactly this reason). `white-space:nowrap` is load-bearing too — at 24px a row
  // WRAPS, and `baselineOfTextNode` then reports the LAST line's baseline while the glyph aligns to the
  // first, which read as a 42px error on the first run.
  await page.reload({ waitUntil: "networkidle0" })
  await page.addStyleTag({ content: "[data-todo-card]{font-size:25px !important}.frizz-todo-row{font-size:24px !important;white-space:nowrap}.frizz-bash-header .frizz-bash-label,.frizz-bash-header [data-todo-headline]{font-size:23px !important}" })
  await page.waitForSelector("[data-todo-card]", { timeout: 20_000 })
  for (const toggle of await page.$$('button[aria-label*="tool calls"]')) {
    if ((await toggle.evaluate((el) => el.getAttribute("aria-expanded"))) === "false") await toggle.click()
  }
  await page.waitForFunction(() => document.querySelectorAll("[data-todo-card]").length >= 1, { timeout: 10_000 })
  await (await page.$("[data-todo-card]")).$eval(".frizz-bash-header", (el) => el.click())
  await page.waitForSelector("[data-todo-card] .frizz-todo-list", { timeout: 10_000 })
  const scaled = await page.evaluate(measureInk)
  for (const a of scaled) console.log(`      ink@2x  ${a.glyph.padEnd(20)} text ${a.fontSize}px  nudge ${a.nudgeDownPx > 0 ? "+" : ""}${a.nudgeDownPx}px`)
  // The ROWS are exactly scale-invariant, so they are held to the same tolerance as at 1x.
  const worstRow = scaled.filter((a) => a.glyph.startsWith("row")).reduce((w, a) => (Math.abs(a.nudgeDownPx) > Math.abs(w.nudgeDownPx) ? a : w))
  check(Math.abs(worstRow.nudgeDownPx) <= 0.3, "the rows' em correction holds exactly at DOUBLE the font size",
    `worst: ${worstRow.glyph} off by ${worstRow.nudgeDownPx}px`)
  // The HEADER is not, and that is a property of the geometry rather than of the correction. Measured raw
  // (correction neutralized, one pass per page load, cap height and glyph ink both scaling EXACTLY):
  // 11.5px needs -1.576px (-0.137em), 23px needs -2.152px (-0.0935em), 46px needs -4.319px (-0.0939em).
  // Proportional from 23px up, but half a pixel adrift at 11.5px — an 11.5px box centred on a flex line
  // lands on a sub-pixel Chrome resolves differently than it does at 23px. No single em value can zero
  // both, so the shipped value is the one measured AT THE SIZE THAT SHIPS (11.5px, residual 0px); the
  // header renders at no other size. This bound just pins the drift so a future change to the header's
  // metrics can't quietly grow it.
  const hdr = scaled.find((a) => a.glyph.startsWith("header"))
  check(Math.abs(hdr.nudgeDownPx) <= 1.05, "the header's correction stays bounded at DOUBLE the font size (see comment)",
    `off by ${hdr.nudgeDownPx}px`)

  // ---- CODEX: a different to-do protocol, the SAME card ----
  const codex = page
  await codex.goto(`http://127.0.0.1:${port}/thread/${CODEX_SLUG}`, { waitUntil: "networkidle0" })
  await codex.waitForSelector("[data-todo-card]", { timeout: 20_000 })
  for (const toggle of await codex.$$('button[aria-label*="tool calls"]')) {
    if ((await toggle.evaluate((el) => el.getAttribute("aria-expanded"))) === "false") await toggle.click()
  }
  const codexCards = await codex.$$("[data-todo-card]")
  check(codexCards.length === 2, "both codex update_plan shapes render a to-do card", `saw ${codexCards.length}`)
  for (const card of codexCards) await card.$eval(".frizz-bash-header", (el) => el.click())
  await codex.waitForFunction(() => document.querySelectorAll("[data-todo-card] .frizz-todo-list").length === 2, { timeout: 10_000 })
  const codexSeen = await codex.evaluate(() =>
    [...document.querySelectorAll("[data-todo-card]")].map((card) => ({
      header: card.querySelector(".frizz-bash-header").textContent.replace(/\s+/g, " ").trim(),
      rows: [...card.querySelectorAll(".frizz-todo-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
      note: card.querySelector(".frizz-bash-output-body")?.textContent,
    })))
  const [direct, wrapper] = codexSeen
  check(direct.header.includes("Inspect the PR context") && direct.header.includes("1/3"),
    "the direct function_call form headlines the step in progress", direct.header)
  check(direct.rows.length === 3 && direct.rows[0].endsWith("done") && direct.rows[1].endsWith("in progress"),
    "its rows carry each step's own status", JSON.stringify(direct.rows))
  check(direct.note?.includes("Instructions are loaded"), "the plan's explanation becomes the note pane", direct.note)
  // The wrapper's args are a JS object literal, so a JSON parser would have produced nothing here.
  check(wrapper.header.includes("Deliver severity-ordered findings") && wrapper.header.includes("2/3"),
    "the JS-WRAPPER form is scanned out of the object literal, mixed quoting and all", wrapper.header)
  check(wrapper.rows.filter((r) => r.endsWith("done")).length === 2, "the wrapper form's statuses survive the scan", JSON.stringify(wrapper.rows))
  if (shots) {
    const shot = await codex.$$("[data-todo-card]")
    await shot[0].screenshot({ path: join(shots, "todo-codex.png") })
  }
  check(pageErrors.length === 0, "no console or page errors (codex thread included)", pageErrors.join(" | "))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
