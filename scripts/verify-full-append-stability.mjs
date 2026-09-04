// Verify APPEND STABILITY on the /full standalone thread page against a REAL running stack.
//
// verify-midscroll-stability.mjs guards the thread DRAWER against events that add or move whole ROWS.
// This guards the surface the maintainer actually reads (`/thread/<slug>/full`) against the append that
// dominates a live turn and that no harness covered: a TOOL CALL, which Claude records as a second
// assistant line carrying the SAME `message.id`, so the projector MERGES it into the message already at
// the tail (transcript.ts pushToolPart / the `id === lastAssistantId` target). The row count never
// changes and no row key ever changes — the last row simply gets TALLER, several times a second.
//
// That is a different code path from "a new row appended", and the reported bug lives in it: a reader
// parked mid-thread gets hauled to the bottom every time a tool call lands.
//
// It measures what the READER perceives — the viewport-relative Y of a named row on screen — not
// scrollTop, which a virtualizer legitimately moves to hold rows still.
//
// Usage — boot a disposable stack first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-full-append-stability.mjs --home=/abs/temp-home --url=http://127.0.0.1:PORT/
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, url } = flags
const cwd = flags.cwd ?? process.cwd()
const shotDir = flags.shots ?? tmpdir()
if (!home || !url) {
  console.error("usage: node scripts/verify-full-append-stability.mjs --home=/abs/temp-home --url=http://127.0.0.1:PORT/")
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const SLUG = "verify-full-append"
const SESSION = "fullappe-0000-4000-8000-000000000000"
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const jsonl = join(jsonlDir, `${SESSION}.jsonl`)

const now = () => new Date().toISOString()
let n = 0
const base = () => ({ parentUuid: null, isSidechain: false, uuid: `${(++n).toString().padStart(8, "0")}-0000-4000-8000-000000000000`, timestamp: now(), session_id: SESSION, cwd })
const user = (text) => ({ ...base(), type: "user", message: { role: "user", content: text } })
// A fresh `message.id` ⇒ a NEW rendered row.
const assistant = (text, stop = null) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text }], ...(stop ? { stop_reason: stop } : {}), usage: { input_tokens: 2, output_tokens: 80 } },
})
// The SAME `message.id` ⇒ the projector merges these blocks into the message already at the tail. This is
// how every tool call and every prose continuation of a live turn actually arrives.
const merged = (id, content) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id, type: "message", role: "assistant", content, usage: { input_tokens: 2, output_tokens: 40 } },
})
const toolCall = (id, toolUseId, name, input) => merged(id, [{ type: "tool_use", id: toolUseId, name, input }])
const toolResult = (toolUseId, content) => ({ ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] } })
const prose = (paras, label) => Array.from({ length: paras }, (_, i) =>
  `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure.`).join("\n\n")

// Settled history, one long standing ask, then a long in-flight turn for the reader to park inside — the
// real shape of a working thread. The turn is left WITHOUT a stop_reason so it stays in flight (the
// Working… runtime-status row is the last row, exactly as on a live thread).
const seed = []
for (let i = 0; i < 8; i++) {
  seed.push(user(`TASK:\nAsk ${i + 1}: earlier settled exchange.`))
  seed.push(assistant(prose(2 + (i % 4), `Reply ${i + 1}`), "end_turn"))
}
seed.push(user(`TASK:\n${prose(4, "The standing ask")}`))
for (let i = 0; i < 14; i++) seed.push(assistant(prose(3 + (i % 4), `Working step ${i + 1}`)))
// The id of the message now at the tail — what a tool call in this turn merges into.
const TAIL_ID = `msg_${n}`
writeFileSync(jsonl, seed.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
  VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Full append stability', 'claude', 'opus', 'high', 'default')`])
const append = (record) => appendFileSync(jsonl, JSON.stringify(record) + "\n")
const api = createRpcClient(url)

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  // THE SURFACE UNDER TEST: the standalone /full page, not the drawer.
  await page.goto(new URL(`/thread/${SLUG}/full`, url).href, { waitUntil: "networkidle2", timeout: 30000 })
  await page.waitForFunction("document.querySelector('[data-standalone-thread] [data-drawer-transcript-scroll] [data-virtualized-transcript]')", { timeout: 20000 })

  const settle = (ms = 1600) => page.evaluate(async (wait) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 20; i++) await raf()
    await new Promise((r) => setTimeout(r, wait))
    for (let i = 0; i < 20; i++) await raf()
  }, ms)

  const probe = () => page.evaluate(() => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    const boxEl = document.querySelector("[data-virtualized-transcript]")
    const top = el.getBoundingClientRect().top
    const rows = Array.from(boxEl.querySelectorAll("[data-transcript-row-key]"))
      .map((r) => ({ key: r.dataset.transcriptRowKey, y: r.getBoundingClientRect().top - top, h: r.getBoundingClientRect().height }))
      .sort((a, b) => a.y - b.y)
    const anchor = rows.find((r) => r.y + r.h > 240) ?? rows[0]
    return {
      anchorKey: anchor?.key ?? null,
      anchorY: anchor ? Math.round(anchor.y) : null,
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      jumpVisible: Boolean(document.querySelector("[data-jump-to-latest]")),
      standalone: Boolean(document.querySelector("[data-standalone-thread]")),
      overflowAnchor: getComputedStyle(el).overflowAnchor,
    }
  })
  // The merge is a PROJECTION claim, so read it off the server rather than inferring it from the
  // virtualized DOM (the tail row is not even rendered while the reader sits mid-thread). Same message
  // count + a longer parts array on the same tail sourceId ⇒ the tool call merged into an existing row.
  const projection = async () => {
    const page = await api.query("threadTranscript", { slug: SLUG })
    const last = page.messages[page.messages.length - 1]
    return { count: page.messages.length, tailSourceId: last?.sourceId ?? null, tailParts: last?.parts?.length ?? 0 }
  }
  const rowY = (key) => page.evaluate((k) => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    const boxEl = document.querySelector("[data-virtualized-transcript]")
    const top = el.getBoundingClientRect().top
    const row = Array.from(boxEl.querySelectorAll("[data-transcript-row-key]")).find((r) => r.dataset.transcriptRowKey === k)
    return row ? Math.round(row.getBoundingClientRect().top - top) : null
  }, key)

  await settle()
  check("the surface under test is the standalone /full page", (await probe()).standalone)

  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-drawer-transcript-scroll]").getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await page.mouse.move(box.x, box.y)
  for (let i = 0; i < 12; i++) { await page.mouse.wheel({ deltaY: -300 }); await new Promise((r) => setTimeout(r, 50)) }
  await settle(1000)

  let m = await probe()
  check("the reader is parked mid-transcript, detached", m.distance > 500 && m.jumpVisible, `distance=${m.distance} jump=${m.jumpVisible} anchorY=${m.anchorY}`)
  check("the transcript scroller owns its offset alone (native scroll anchoring off)", m.overflowAnchor === "none", `overflow-anchor=${m.overflowAnchor}`)
  const anchorKey = m.anchorKey
  let lastY = m.anchorY
  let lastScrollTop = m.scrollTop
  let lastHeight = m.scrollHeight
  await page.screenshot({ path: join(shotDir, "fullappend-0-parked.png") })

  const perturb = async (label, act, wait = 1600) => {
    await act()
    await settle(wait)
    const y = await rowY(anchorKey)
    const after = await probe()
    check(
      `/full mid-scroll: ${label}`,
      y !== null && y === lastY,
      `anchor Y ${lastY} → ${y} (drift ${y === null ? "row gone" : `${y - lastY}px`}), scrollTop ${lastScrollTop} → ${after.scrollTop}, height ${lastHeight} → ${after.scrollHeight}`,
    )
    if (y !== null) lastY = y
    lastScrollTop = after.scrollTop
    lastHeight = after.scrollHeight
    return after
  }

  // THE REPORTED CASE — a tool call merged into the message already at the tail.
  const beforeProjection = await projection()
  const beforeTool = await probe()
  const afterTool = await perturb(
    "a TOOL CALL merged into the tail message leaves the reader untouched",
    () => append(toolCall(TAIL_ID, "toolu_full_1", "Bash", { command: "npm test -- --run packages/web", description: "Run the web test suite" })),
  )
  const afterProjection = await projection()
  check(
    "the tool call really did MERGE into the existing tail row (this case is not passing vacuously)",
    afterProjection.count === beforeProjection.count
      && afterProjection.tailSourceId === beforeProjection.tailSourceId
      && afterProjection.tailParts > beforeProjection.tailParts
      && afterTool.scrollHeight > beforeTool.scrollHeight,
    `messages ${beforeProjection.count} → ${afterProjection.count}, tail parts ${beforeProjection.tailParts} → ${afterProjection.tailParts}, height ${beforeTool.scrollHeight} → ${afterTool.scrollHeight}`,
  )

  await perturb(
    "the tool RESULT back-filling that same row leaves the reader untouched",
    () => append(toolResult("toolu_full_1", "PASS  128 tests passed in 12.4s\nPASS  all suites green")),
  )
  await perturb(
    "more PROSE merged into the tail message leaves the reader untouched",
    () => append(merged(TAIL_ID, [{ type: "text", text: prose(3, "Continuing the same turn") }])),
  )

  // A realistic burst: several calls landing back to back, the way a working turn actually streams.
  await perturb("a BURST of five tool calls leaves the reader untouched", async () => {
    for (let i = 2; i <= 6; i++) {
      append(toolCall(TAIL_ID, `toolu_full_${i}`, "Read", { file_path: `/Users/x/project/src/module-${i}.ts` }))
      await new Promise((r) => setTimeout(r, 120))
    }
  }, 2200)

  await perturb(
    "a NEW assistant message appended at the tail leaves the reader untouched",
    () => append(assistant(prose(6, "A landing reply"))),
  )
  await perturb("idling with NOTHING landing leaves the reader untouched", async () => {}, 3000)

  m = await probe()
  check("the reader is still detached after everything landed", m.jumpVisible, `jump=${m.jumpVisible} distance=${m.distance}`)
  await page.screenshot({ path: join(shotDir, "fullappend-1-final.png") })

  check("no console or page errors", errors.length === 0, errors.join(" | "))
  console.log(`\nscreenshots → ${shotDir}/fullappend-*.png`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
