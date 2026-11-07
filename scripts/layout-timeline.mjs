// THE LAYOUT TIMELINE — every distinct arrangement a thread page paints around one moment, with the event
// that committed each, on one clock. Built to answer "why does this jump around?" (maintainer 2026-10-13,
// over a one-second recording of pressing Done: "Look at all the layout shift that happens in this
// clip … figure out whatever it takes to gauge why").
//
// The ideal around any send, steer or rest is ONE geometry change per piece of new content, and no state
// that exists only in between. Every extra state is a defect with a cause, and this prints the cause's
// neighbourhood: each `■` line is a distinct visible layout (row tops and heights in the scroller, the
// scroll offset, Jump to latest, and the page's chrome: footer, prompt box, scroller, row x-extents) and
// each `⟵` line is what arrived in between — a board delta (with the thread's runtime), a transcript push
// (its last messages: role/kind/queued/deliveryState), an RPC, a layout-shift entry. Two things geometry
// ignores by design are tracked beside it, because both are defects when they flash: `◐` lines are opacity
// changes of dimmed bubbles (a send's ghost is 2: it appears dimmed, it lands; more is a flicker, and a
// CSS fade would read as many), and the summary lists every time the live Working row came or went (once
// each per turn). A label-only change — the Working clock ticking — is neither.
//
// It records, on the page's own clock (0 = the action):
//   · every rAF frame's visible `[data-transcript-row-key]` rows inside `[data-drawer-transcript-scroll]`;
//   · every inbound WebSocket frame for the thread and every non-board RPC (a WebSocket/fetch shim
//     installed before the app loads);
//   · PAINTED frames through the CDP screencast into `<out>/frames/NNN_±MMMMMms.jpg`. DOM samples show
//     what the DOM held, not what was painted; when a state is in doubt, look at the frames.
//
// THE WORKER IS `scripts/scripted-claude.mjs`, never a live model: a live Claude on a sandbox stack raises
// a keychain dialog on the maintainer's screen (AGENTS.md § Never put a macOS keychain dialog…), and a
// script's timings can be repeated. Boot a stack with it as the Claude binary, rest a thread on the
// ending you want, then record:
//
//   nub scripts/adhoc-stack.mjs --port=4980 --project=<throwaway repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   api.mutate("dispatch", { prompt: "[script ending=steps paras=14] …", backend: "claude" })   // then wait for turn-idle
//   nub scripts/layout-timeline.mjs --url=http://127.0.0.1:4980/project/<p> --slug=<thread>
//     [--action=send|steps|answer|markdone|none]
//          send      type --message into the prompt box and press Send (default)
//          steps     tick an awaiting card's "I have completed this" box, then Send
//          answer    pick a registered question's option (--option=<text>, default the first), then Send
//          markdone  press a ```done card's "Mark as done"
//          none      press nothing
//     [--start=rpc]         at 0, start a turn with a followUp over RPC — a send from ANOTHER tab. Use with
//                           --action=none to watch a turn open, run and rest with nobody at the keyboard
//     [--start=rpc-tab]     the same send carrying a deliveryId, as another tab's prompt box sends it: the
//                           server opens a ledger entry first (its ghost bubble, deliveryInFlight). Plain
//                           `rpc` has none, which is how a worker's steerThread sends — a different path
//     [--steers=1500,1900]  ms after 0 at which the page types a steer and presses Send, into the running turn
//     [--drawer]            record the board's drawer (`?thread=<slug>`) instead of the thread page
//     [--message=text] [--ms=9000] [--out=/abs/dir] [--w=1400] [--h=900]
//
// MORE SURFACES AND ACTIONS (2026-10-14, the layout sweep). Each is recorded the same way, on the same
// clock, and counted the same way — a state is a change of the rows' tops and heights, the scroll offset,
// Jump to latest, or the surface's chrome:
//     [--surface=page|drawer|card|sub]   what is sampled. `card` is the thread's queue card on the board
//                           (`[data-queue-card-root]`; the WINDOW is its scroller, and every other card's
//                           top is part of its chrome, so a neighbour that moves counts). `sub` is a
//                           sub-agent drawer (SubAgentSheet): its scroller, its rows, its header and the
//                           lifecycle slot at the header's right. `--drawer` is `--surface=drawer`.
//     [--from=page|drawer|card|board]    the page loaded before the action, when it is not the surface
//                           itself: `--surface=sub --from=page` opens the thread page and records the
//                           sub-agent drawer opened over it; `--from=board` loads the board with nothing
//                           open (opening a thread from the rail)
//     [--pre=open-sub]      open the sub-agent drawer BEFORE the action (so `--action=none` watches a child
//                           finish with its drawer open, and `--action=close` closes it)
//     [--label=text]        which sub-agent row `open-sub` presses (default: the first Agent row)
//     [--action=…]          also:
//          open-sub  press a sub-agent's title in the thread's transcript (its Agent row)
//          close     press Escape — the top drawer closes
//          rail      press the thread's row in the board's left rail (it opens a drawer)
//          rail-full press that row's "Open fullscreen" door (it navigates to the full page)
//          page-up   wheel the transcript to its top, so older messages page in; the report then
//                    follows the row the reader was looking at (ANCHOR lines) — it must not move
//          restart   restart the server under the page: the page's supervisor poll is answered
//                    "restarting" (the overlay a real supervised restart raises), `--cmd` is run (it
//                    must stop the stack and boot it again on the same HOME and port, and return once
//                    it answers), then "ready". Nothing on screen may move after the reconnect
//     [--start=rename|pin|unpin|snooze]  at 0, change the thread on the BOARD over RPC, as another tab
//                           would: rename it, pin or unpin it, snooze it for an hour. Only what changed
//                           may move
//
// Two readings beside the geometry count, so a change outside the surface is seen without changing what
// the count has always meant: `rail states` (every left-rail row's top, and its count) and `side states`
// (the full page's right-hand rail, FocusRail, row by row). And `flash frames`: frames in which the
// surface's scroller existed with no rows in it, after the first frame that had rows.
//
// The page is `/thread/<slug>/full` unless `--drawer`. The board route opens a drawer only for a thread
// that holds no queue card — one that is running, snoozed or done — so start its turn, snooze it or
// complete it over RPC first; a thread resting in the queue opens there as its queue card, which is a
// different surface (TodosView) and is not sampled here.
//
// Measured with it on 2026-10-13, scripted workers, 3+ runs per cell at 1400 and 820 wide, short and tall
// threads: a send from any rest (steps, done, needs_input, bare, a question's answer) paints 2 states; a
// turn opened from another tab paints 2 (it opens, it rests); a steer adds 3; two steers add 5. Before the
// fixes it found, the same send painted 4.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { launchHeadless } from "./lib/headless-browser.mjs"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
  const s = a.slice(2)
  const i = s.indexOf("=")
  return i < 0 ? [s, "1"] : [s.slice(0, i), s.slice(i + 1)]
}))
const { url, slug } = flags
if (!url || !slug) {
  console.error("usage: nub scripts/layout-timeline.mjs --url=http://127.0.0.1:PORT/project/<p> --slug=<thread> [--action=send|steps|answer|markdone|none] [--start=rpc] [--steers=1500,1900] [--message=…] [--ms=9000] [--out=…]")
  process.exit(1)
}
const startRpc = flags.start === "rpc" || flags.start === "rpc-tab"
const boardChange = ["rename", "pin", "unpin", "snooze"].includes(flags.start) ? flags.start : null
const surface = flags.surface ?? (flags.drawer ? "drawer" : "page")
const from = flags.from ?? (surface === "sub" ? "page" : surface)
const steers = (flags.steers ?? "").split(",").filter(Boolean).map(Number)
const action = flags.action ?? (startRpc || boardChange || steers.length ? "none" : "send")
const typed = action === "send"
const message = flags.message ?? (typed ? "Thanks. One more thing: summarise it in one sentence." : "")
const ms = Number(flags.ms ?? 9000)
const outDir = flags.out ?? join(tmpdir(), `layout-timeline-${slug}-${Date.now()}`)
mkdirSync(join(outDir, "frames"), { recursive: true })
const sleep = (n) => new Promise((r) => setTimeout(r, n))
const STEER_TEXT = ["Also: mention the word pineapple.", "And end with a one-line summary."]
const api = createRpcClient(`${new URL(url).origin}/`)

const browser = await launchHeadless()
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: Number(flags.w ?? 1400), height: Number(flags.h ?? 900), deviceScaleFactor: 1 })
  page.on("pageerror", (e) => errors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)) })
  if (action === "restart") await page.evaluateOnNewDocument(() => { window.__holdVite = true })
  let acting = false
  page.on("framenavigated", (frame) => { if (acting && action === "restart" && frame === page.mainFrame()) errors.push(`navigated: ${frame.url()}`) })
  await page.evaluateOnNewDocument((slug) => {
    window.__log = []
    const log = (e) => window.__log.push({ t: performance.now(), ...e })
    window.__mark = log
    // The thread's own pane: the nearest ancestor of its scroller that holds a prompt box. The board
    // route has another prompt box (the dispatch one) and one per queue card.
    window.__threadPane = () => {
      let n = document.querySelector("[data-drawer-transcript-scroll]")
      while (n && !n.querySelector("[data-composer-box]")) n = n.parentElement
      return n ?? document
    }
    window.__pane = () => {
      if (window.__surface === "card") return document.querySelector(`[data-queue-card-root="${CSS.escape(slug)}"]`) ?? document
      if (window.__surface === "sub") return document.querySelector("[data-subagent-header]")?.parentElement ?? document
      return window.__threadPane()
    }
    // What the sampler reads, per surface: the scroller, its rows (with a key each), and the chrome.
    window.__surfaceRead = () => {
      const surface = window.__surface
      if (surface === "card") {
        const root = document.querySelector(`[data-queue-card-root="${CSS.escape(slug)}"]`)
        // A card on its way out (its dissolve) is a card that has left: its fade is one designed
        // transition, not a state per frame of it.
        if (!root || root.closest("[data-queue-card]")?.getAttribute("data-queue-leaving") === "true") return null
        return {
          scroller: document.scrollingElement,
          pane: { top: 0, bottom: window.innerHeight },
          rows: [...root.querySelectorAll("[data-transcript-source-id]")].map((el) => [el.dataset.transcriptSourceId, el]),
          chrome: { card: root, box: root.querySelector("[data-composer-box]"), cards: [...document.querySelectorAll("[data-queue-card]")] },
        }
      }
      if (surface === "sub") {
        const header = document.querySelector("[data-subagent-header]")
        const scroller = header?.nextElementSibling
        if (!scroller) return null
        const column = scroller.querySelector("[data-transcript-column]")
        return {
          scroller,
          pane: scroller.getBoundingClientRect(),
          rows: column ? [...column.children].map((el, i) => [`r${i}`, el]) : [],
          chrome: { header, facts: header.querySelector("[data-subagent-header-facts]"), slot: header.lastElementChild, box: header.parentElement.querySelector("[data-subagent-steer] [data-composer-box], [data-subagent-steer]"), footer: scroller.nextElementSibling },
        }
      }
      const scroller = document.querySelector("[data-drawer-transcript-scroll]")
      if (!scroller) return null
      const pane = window.__threadPane()
      return {
        scroller,
        pane: scroller.getBoundingClientRect(),
        rows: [...scroller.querySelectorAll("[data-transcript-row-key]")].map((el) => [el.dataset.transcriptRowKey, el]),
        chrome: { footer: pane.querySelector("[data-thread-chat-footer]"), box: pane.querySelector("[data-composer-box]") },
      }
    }
    const Socket = window.WebSocket
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args)
        // Vite's dev client reloads the whole page when its socket drops and the dev server comes back —
        // a dev-only reload a shipped Frizz never does. Across `--action=restart` it must not hear the drop.
        if (window.__holdVite && String(args[1] ?? "").includes("vite")) {
          const add = this.addEventListener.bind(this)
          this.addEventListener = (type, ...rest) => (type === "close" || type === "error" ? undefined : add(type, ...rest))
          Object.defineProperty(this, "onclose", { set() {}, get() { return null } })
        }
        // Registered before the app's own handler, so the time is the frame's arrival.
        this.addEventListener("message", (e) => {
          const raw = typeof e.data === "string" ? e.data : ""
          let m
          try { m = JSON.parse(raw) } catch { return }
          if (m.t === "hb") return
          if (m.t === "transcript") {
            if (m.slug !== slug) return
            const tail = (m.messages ?? []).slice(-4).map((x) => `${x.role}${x.kind ? "/" + x.kind : ""}${x.queued ? "/Q" : ""}${x.deliveryState ? "/" + x.deliveryState : ""}:${String(x.text ?? "").replace(/\s+/g, " ").slice(0, 20)}`)
            log({ ev: "ws-transcript", n: m.messages?.length, tail })
          } else if (m.t === "event") {
            if (m.event?.type === "vite") return
            const i = raw.indexOf(`"${slug}"`)
            if (i < 0) return
            // The thread's own row in the delta: its fields follow its id.
            const near = raw.slice(i, i + 6000)
            const pick = (k) => new RegExp(`"${k}":("[^"]*"|true|false|null|\\d+)`).exec(near)?.[1]
            log({ ev: `ws-${m.event?.type ?? "event"}`, runtime: pick("runtime"), needsYou: pick("needsYou"), deliveryInFlight: pick("deliveryInFlight") })
          }
        })
      }
    }
    const fetchOriginal = window.fetch
    window.fetch = async (...args) => {
      // A dev stack has no supervisor; while `--action=restart` runs, the page hears one that says so.
      if (window.__supervisor && String(args[0]?.url ?? args[0]).includes("/_frizz/control/status")) {
        log({ ev: `supervisor ${window.__supervisor}` })
        return new Response(JSON.stringify({ protocol: 1, updateRestart: false, state: window.__supervisor, artifactDigest: "layout-timeline" }), { status: 200, headers: { "content-type": "application/json" } })
      }
      const rpc = /\/rpc\/(\w+)/.exec(String(args[0]?.url ?? args[0]))?.[1]
      const quiet = !rpc || rpc === "board"
      if (!quiet) log({ ev: "rpc>", rpc })
      const response = await fetchOriginal(...args)
      if (!quiet) log({ ev: "rpc<", rpc, status: response.status })
      return response
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          log({ ev: "layout-shift", value: Math.round(e.value * 10000) / 10000, sources: (e.sources ?? []).map((s) => `${s.node?.closest?.("[data-transcript-row-key]")?.dataset.transcriptRowKey?.slice(0, 24) ?? s.node?.nodeName ?? "?"} ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`) })
        }
      }).observe({ type: "layout-shift" })
    } catch {}
  }, slug)

  const base = url.replace(/\/$/, "")
  const route = from === "page" ? `/thread/${slug}` : from === "drawer" ? `?thread=${slug}` : ""
  await page.goto(`${base}${route}`, { waitUntil: "networkidle2", timeout: 30_000 })
  if (from === "card") {
    await page.waitForSelector(`[data-queue-card-root="${slug}"] [data-transcript-source-id]`, { timeout: 20_000 }).catch(() => {
      throw new Error("no queue card for this thread — is it resting in the queue?")
    })
    // The card's prompt box at the bottom of the window: where a reader at its tail is.
    await page.evaluate((slug) => {
      const box = document.querySelector(`[data-queue-card-root="${CSS.escape(slug)}"] [data-composer-box]`)
      const b = box.getBoundingClientRect()
      window.scrollBy(0, b.bottom + 24 - window.innerHeight)
    }, slug)
  } else if (from === "board") {
    // A snoozed or done thread's row is in a collapsed band: open the bands first, as a reader would.
    await page.waitForSelector("[data-sidebar-item]", { timeout: 20_000 })
    if (!(await page.$(`[data-sidebar-item="${slug}"]`))) {
      await page.evaluate(() => { for (const b of document.querySelectorAll("button")) if (/^(snoozed|done)/i.test((b.textContent ?? "").trim())) b.click() })
    }
    await page.waitForSelector(`[data-sidebar-item="${slug}"]`, { timeout: 20_000 })
  } else {
    await page.waitForSelector("[data-drawer-transcript-scroll] [data-transcript-row-key]", { timeout: 20_000 }).catch(() => {
      throw new Error(from === "drawer" ? "no drawer opened — a thread resting in the queue opens as its queue card on this route" : "no transcript on the page")
    })
  }
  await sleep(2500)
  const pressSubAgent = async () => {
    const handle = await page.evaluateHandle((label) => {
      const pane = window.__threadPane()
      const candidates = [...pane.querySelectorAll("[data-drawer-transcript-scroll] button, [data-drawer-transcript-scroll] [role=button]")]
        .filter((e) => e.getBoundingClientRect().height > 0)
      return candidates.find((e) => label ? (e.textContent ?? "").includes(label) : /Auditing part|sub-agent/i.test(e.textContent ?? "") && !/finished/i.test(e.closest("[data-transcript-row-key]")?.textContent ?? "")) ?? null
    }, flags.label ?? "")
    const element = handle.asElement()
    if (!element) throw new Error("no sub-agent row to press in the transcript")
    await element.evaluate((e) => e.scrollIntoView({ block: "nearest" }))
    const b = await element.boundingBox()
    await page.mouse.click(b.x + Math.min(40, b.width / 2), b.y + b.height / 2)
  }
  if (flags.pre === "open-sub") {
    await pressSubAgent()
    await page.waitForSelector("[data-subagent-header] ~ div [data-transcript-column] > *", { timeout: 20_000 })
    await sleep(2500)
  }
  await page.evaluate((s) => { window.__surface = s }, surface)

  // Stage the input without sending it.
  if (action === "steps") {
    const ticked = await page.evaluate(() => {
      const box = window.__pane().querySelector("[data-steps-complete] button[role=checkbox]")
      box?.click()
      return Boolean(box)
    })
    if (!ticked) throw new Error("no steps checkbox on the page — is the thread resting on an awaiting card with steps?")
    await sleep(300)
  }
  const click = async (handle, what) => {
    const element = handle.asElement()
    if (!element) throw new Error(`no ${what} on the page`)
    const b = await element.boundingBox()
    await page.mouse.click(b.x + Math.min(40, b.width / 2), b.y + b.height / 2)
  }
  if (action === "answer") {
    await click(await page.evaluateHandle((wanted) => {
      const options = [...window.__pane().querySelectorAll("[data-question-grid] [data-question-option]")]
      return (wanted ? options.find((e) => (e.textContent ?? "").includes(wanted)) : options[0]) ?? null
    }, flags.option ?? ""), "question option")
    await sleep(300)
  }
  const promptBox = async () => {
    const box = (await page.evaluateHandle(() => window.__pane().querySelector("[data-composer-box] textarea"))).asElement()
    if (!box) throw new Error("no prompt box on the page")
    await box.click()
  }
  if (typed && message) {
    await promptBox()
    await page.keyboard.type(message, { delay: 2 })
  } else if (steers.length) {
    // The first steer is typed ahead, so its click lands exactly at its offset.
    await promptBox()
    await page.keyboard.type(STEER_TEXT[0], { delay: 2 })
  }
  await sleep(400)

  // A drawer that slides in or out moves sideways on every frame of its slide, and nothing in it moves
  // relative to it: when the action opens or closes one, a state is a change of anything BUT x.
  const ignoreX = surface === "sub" || ["open-sub", "close", "rail", "rail-full"].includes(action)
  await page.evaluate((ms, ignoreX) => {
    window.__frames = []
    const t0 = performance.now()
    const box4 = (b) => ignoreX ? [Math.round(b.top), Math.round(b.height), Math.round(b.width)] : [Math.round(b.top), Math.round(b.height), Math.round(b.left), Math.round(b.width)]
    const rect = (el) => (el ? box4(el.getBoundingClientRect()) : null)
    const sample = () => {
      const read = window.__surfaceRead()
      // Outside the surface: the left rail's rows, and the full page's right-hand rail.
      const railRows = [...document.querySelectorAll("[data-sidebar-item]")].map((e) => `${e.dataset.sidebarItem.slice(0, 12)}@${Math.round(e.getBoundingClientRect().top)}`)
      const sideRail = document.querySelector("[data-focus-rail]")
      const side = sideRail ? [...sideRail.querySelectorAll("button, a, [data-file-dir], li")].map((e) => { const b = e.getBoundingClientRect(); return `${Math.round(b.top)}+${Math.round(b.height)}` }).join(" ") : null
      // Its group headings ("Sub-agents", "Background shells", …) by name and top, so a group that
      // stayed can be told apart from the one that came or went.
      const sideHeads = sideRail ? [...sideRail.querySelectorAll('[class*="uppercase"]')].map((e) => [(e.textContent ?? "").replace(/[0-9\s]+$/, "").trim(), Math.round(e.getBoundingClientRect().top)]) : []
      const overlay = Boolean(document.querySelector('[role="alertdialog"][aria-label="Updating and restarting Frizz"]'))
      if (read) {
        const { scroller, pane } = read
        const xs = new Set()
        const rows = read.rows.map(([k, el]) => {
          const b = el.getBoundingClientRect()
          xs.add(ignoreX ? `${Math.round(b.width)}` : `${Math.round(b.left)}+${Math.round(b.width)}`)
          if (b.bottom < pane.top || b.top > pane.bottom || b.height === 0) return null
          // A ghost's dimming may sit on the row or on the bubble: read the effective opacity up the chain.
          let opacity = 1
          for (let n = el.querySelector(".bg-user-bubble") ?? el; n && n !== scroller && n !== document.body; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
          return { k, y: Math.round(b.top - pane.top), h: Math.round(b.height), l: (el.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 34), live: Boolean(el.querySelector("[data-working-indicator]")) || undefined, op: opacity === 1 ? undefined : Math.round(opacity * 100) / 100 }
        }).filter(Boolean)
        // A sub-agent drawer's own: the thread page under it has its own, and it is not this surface's.
        const jumpScope = window.__surface === "sub" ? (document.querySelector("[data-subagent-header]")?.parentElement ?? document) : document
        const jump = [...jumpScope.querySelectorAll("button")].some((b) => /Jump to latest/.test(b.textContent ?? "") && b.getBoundingClientRect().height > 0 && getComputedStyle(b).visibility !== "hidden" && getComputedStyle(b).opacity !== "0")
        const chrome = { scroller: scroller === document.scrollingElement ? null : box4(scroller.getBoundingClientRect()), rowsX: [...xs].join(" ") }
        for (const [name, el] of Object.entries(read.chrome)) chrome[name] = Array.isArray(el) ? el.map((e) => rect(e)[0]).join(",") : rect(el)
        window.__frames.push({ t: performance.now(), st: Math.round(scroller.scrollTop), max: Math.round(scroller.scrollHeight - scroller.clientHeight), rows, jump, chrome, railRows, side, sideHeads, overlay, empty: read.rows.length === 0 })
      } else {
        window.__frames.push({ t: performance.now(), none: true, st: 0, max: 0, rows: [], jump: false, chrome: null, railRows, side, sideHeads, overlay })
      }
      if (performance.now() - t0 < ms + 2000) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, ms, ignoreX)

  const cdp = await page.createCDPSession()
  const painted = []
  cdp.on("Page.screencastFrame", (f) => {
    painted.push({ wall: Date.now(), data: f.data })
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, everyNthFrame: 1 })
  await sleep(300)
  const clock = await page.evaluate(() => ({ perf: performance.now(), wall: performance.timeOrigin + performance.now() }))
  const zero = await page.evaluate(() => { window.__mark({ ev: "ACTION" }); return performance.now() })
  const zeroWall = Date.now()
  acting = true
  const pressSend = async () => click(await page.evaluateHandle(() => [...window.__pane().querySelectorAll("[data-composer-box] button[aria-label=Send]")].find((b) => !b.disabled && b.getBoundingClientRect().height > 0) ?? null), "enabled Send in the prompt box")

  const pending = []
  if (boardChange) {
    const thread = (await api.query("board")).threads.find((t) => t.id === slug)
    const sessionId = thread?.sessionId
    const change = boardChange === "rename"
      ? api.mutate("renameThread", { slug, title: `Renamed ${Date.now() % 10000}: the release pipeline, end to end` })
      : boardChange === "snooze"
        ? api.mutate("setThreadSnooze", { slug, sessionId, until: new Date(Date.now() + 3600_000).toISOString() })
        : api.mutate("setThreadPinned", { slug, sessionId, pinned: boardChange === "pin" })
    pending.push(change.catch((e) => errors.push(`${boardChange}: ${e.message}`)))
  }
  if (startRpc) {
    const sessionId = (await api.query("board")).threads.find((t) => t.id === slug)?.sessionId
    pending.push(api.mutate("followUp", { slug, sessionId, message: "Go on: expand on the second point.", ...(flags.start === "rpc-tab" ? { deliveryId: `layout-timeline-${Date.now()}` } : {}) }).catch((e) => errors.push(`followUp: ${e.message}`)))
  }
  if (action === "open-sub") {
    await pressSubAgent()
  } else if (action === "close") {
    await page.keyboard.press("Escape")
  } else if (action === "rail" || action === "rail-full") {
    const row = (await page.$(`[data-sidebar-item="${slug}"]`))
    if (!row) throw new Error("no rail row for this thread")
    await row.hover()
    if (action === "rail-full") {
      const door = await row.$('a[aria-label="Open fullscreen"]')
      if (!door) throw new Error("no fullscreen door on the rail row")
      await door.click()
    } else {
      await (await row.$("button")).click()
    }
  } else if (action === "page-up") {
    // The reader scrolls up with the wheel until the scroller is at its top, and then stops.
    const center = await page.evaluate(() => { const b = window.__surfaceRead().scroller.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })
    await page.mouse.move(center.x, center.y)
    for (let i = 0; i < 400; i++) {
      await page.mouse.wheel({ deltaY: -600 })
      await sleep(16)
      const top = await page.evaluate(() => window.__surfaceRead().scroller.scrollTop)
      const asked = await page.evaluate(() => window.__log.some((e) => e.rpc === "threadTranscriptEarlier"))
      if (top <= 0 || asked) break
    }
    await page.evaluate(() => window.__mark({ ev: "READER-STOPPED" }))
  } else if (action === "restart") {
    if (!flags.cmd) throw new Error("--action=restart needs --cmd=<a shell command that restarts the stack on the same HOME and port>")
    await page.evaluate(() => { window.__supervisor = "restarting"; window.dispatchEvent(new Event("frizz:supervisor-status-wake")) })
    await sleep(600)
    const { execSync } = await import("node:child_process")
    await page.evaluate(() => window.__mark({ ev: "RESTART-CMD" }))
    execSync(flags.cmd, { stdio: "ignore", shell: "/bin/sh", timeout: 120_000 })
    await page.evaluate(() => window.__mark({ ev: "SERVER-BACK" }))
    await api.waitForHealth()
    await page.evaluate(() => { window.__supervisor = "ready"; window.dispatchEvent(new Event("frizz:supervisor-status-wake")) })
    await sleep(800)
    await page.evaluate(() => { window.__supervisor = null })
  } else if (action === "markdone") {
    await click(await page.evaluateHandle(() => [...document.querySelectorAll("[data-drawer-transcript-scroll] button")].find((b) => /Mark as done/.test(b.textContent ?? "") && !b.disabled) ?? null), "Mark as done in the transcript")
  } else if (action !== "none") {
    await pressSend()
  }
  for (const [i, at] of steers.entries()) {
    if (i > 0) {
      await sleep(Math.max(0, zeroWall + at - 600 - Date.now()))
      await page.keyboard.type(STEER_TEXT[i % STEER_TEXT.length], { delay: 1 })
    }
    await sleep(Math.max(0, zeroWall + at - Date.now()))
    await page.evaluate((i) => window.__mark({ ev: `STEER${i}` }), i)
    await pressSend()
  }
  await Promise.all(pending)
  await sleep(Math.max(0, zeroWall + ms - Date.now()))
  await cdp.send("Page.stopScreencast")
  const { log, frames } = await page.evaluate(() => ({ log: window.__log, frames: window.__frames }))
  painted.forEach((f, i) => {
    const t = Math.round(f.wall - clock.wall + clock.perf - zero)
    writeFileSync(join(outDir, "frames", `${String(i).padStart(4, "0")}_${t < 0 ? "-" : "+"}${String(Math.abs(t)).padStart(5, "0")}ms.jpg`), Buffer.from(f.data, "base64"))
  })
  writeFileSync(join(outDir, "raw.json"), JSON.stringify({ zero, log, frames }))

  const at = (t) => `${String(Math.round(t - zero)).padStart(6)}ms`
  const lines = log.filter((e) => e.t >= zero - 50).map((e) => ({ t: e.t, text: `${at(e.t)}  ⟵ ${e.ev}${e.rpc ? ` ${e.rpc}` : ""}${e.status ? ` ${e.status}` : ""}${e.runtime ? ` runtime=${e.runtime}` : ""}${e.needsYou ? ` needsYou=${e.needsYou}` : ""}${e.deliveryInFlight ? ` deliveryInFlight=${e.deliveryInFlight}` : ""}${e.n ? ` n=${e.n} tail=${JSON.stringify(e.tail)}` : ""}${e.value !== undefined ? ` ${e.value} ${JSON.stringify(e.sources)}` : ""}` }))
  // A geometry state changes only with the scroll offset, Jump to latest, a row's top or height, or the
  // page's chrome — never with a label or an opacity.
  const geometry = (f) => JSON.stringify([f.st, f.max, f.jump, f.rows.map((r) => [r.y, r.h]), f.chrome])
  // By label, not key: a send's bubble changes key twice on its way in (optimistic, delivery, landed).
  const dimmed = (f) => JSON.stringify(f.rows.filter((r) => r.op !== undefined).map((r) => [r.l.slice(0, 24), r.op]))
  // The page follows its tail, so a live row out of view is a live row gone.
  const working = (f) => f.rows.some((r) => r.live)
  const rowsOf = (f) => f.rows.map((r) => `            ${r.k.startsWith("queued") ? "Q" : " "}[${r.y}+${r.h}${r.op ? ` op${r.op}` : ""}] ${r.l}`).join("\n")
  const before = frames.filter((f) => f.t < zero).pop()
  const railSig = (f) => f.railRows.join(" ")
  let railStates = 0
  let sideStates = 0
  // A side-rail group that is there before and after a change and moved anyway: what a change to ANOTHER
  // group did to it. The rail's own reading, beside `side states`, which counts every change of any row.
  let sideStandingMoves = 0
  let flashFrames = 0
  let hadRows = Boolean(before && before.rows.length)
  {
    let r = before ? railSig(before) : null
    let sd = before ? before.side : null
    let heads = new Map(before?.sideHeads ?? [])
    for (const f of frames) {
      if (f.t < zero) continue
      if (railSig(f) !== r) { r = railSig(f); railStates++; lines.push({ t: f.t, text: `${at(f.t)}  ▤ rail ${f.railRows.length} rows: ${f.railRows.slice(0, 8).join(" ")}${f.railRows.length > 8 ? " …" : ""}` }) }
      if (f.side !== sd) { sd = f.side; sideStates++; lines.push({ t: f.t, text: `${at(f.t)}  ▥ side rail ${f.side ?? "(none)"}` }) }
      const nextHeads = new Map(f.sideHeads ?? [])
      const moved = [...nextHeads].filter(([head, top]) => heads.has(head) && heads.get(head) !== top)
      if (moved.length) { sideStandingMoves++; lines.push({ t: f.t, text: `${at(f.t)}  ▥ side group stayed and moved: ${moved.map(([head, top]) => `${head} ${heads.get(head)}→${top}`).join(", ")}` }) }
      heads = nextHeads
      if (f.rows.length) hadRows = true
      else if (hadRows && f.empty) flashFrames++
    }
  }
  // The row the reader was looking at when they stopped scrolling, followed to the end (--action=page-up).
  // Followed from the last frame before the earlier page ARRIVED — what the reader was looking at when
  // it was asked for — or, with none asked for, from where the reader stopped.
  const earlierAt = log.find((e) => e.ev === "rpc<" && e.rpc === "threadTranscriptEarlier")?.t
  const stopped = earlierAt !== undefined ? frames.filter((f) => f.t < earlierAt && f.rows.length).pop()?.t : log.find((e) => e.ev === "READER-STOPPED")?.t
  const anchorReport = []
  if (stopped !== undefined) {
    const first = frames.find((f) => f.t >= stopped && f.rows.length)
    const anchor = first?.rows.find((r) => r.y >= 0 && !r.k.startsWith("earlier-history")) ?? first?.rows[0]
    if (anchor) {
      let last = anchor.y
      let moves = 0
      let worst = 0
      for (const f of frames) {
        if (f.t < first.t) continue
        const row = f.rows.find((r) => r.k === anchor.k)
        const y = row ? row.y : null
        if (y === last) continue
        moves++
        if (y !== null) worst = Math.max(worst, Math.abs(y - anchor.y))
        lines.push({ t: f.t, text: `${at(f.t)}  ⚓ ANCHOR ${anchor.l.slice(0, 24)} y=${y ?? "gone"} (was ${anchor.y})` })
        last = y
      }
      anchorReport.push(`anchor row "${anchor.l.slice(0, 24)}" moved ${moves} times ${earlierAt !== undefined ? "from the frame before the earlier page arrived" : "after the reader stopped"}, at most ${worst}px`)
    }
  }
  let states = 0
  const firstSteer = log.find((e) => e.ev === "STEER0")?.t
  let statesBeforeSteer = 0
  let previous = before ? geometry(before) : null
  let previousDimmed = before ? dimmed(before) : null
  let previousWorking = before ? working(before) : null
  const workingFlips = []
  let opacityFlips = 0
  if (before) lines.push({ t: before.t, text: `${at(before.t)}  ■ BEFORE st=${before.st}/${before.max}${before.none ? " (no surface)" : ""}\n${rowsOf(before)}` })
  let overlay = before?.overlay ?? false
  for (const f of frames) if (f.t >= zero && f.overlay !== overlay) { overlay = f.overlay; lines.push({ t: f.t, text: `${at(f.t)}  ▣ restart overlay ${overlay ? "up" : "down"}` }) }
  for (const f of frames) {
    if (f.t < zero) continue
    if (working(f) !== previousWorking) { previousWorking = working(f); workingFlips.push(`${Math.round(f.t - zero)}ms ${previousWorking ? "on" : "off"}`) }
    if (dimmed(f) !== previousDimmed) { previousDimmed = dimmed(f); opacityFlips++; lines.push({ t: f.t, text: `${at(f.t)}  ◐ opacity ${previousDimmed}` }) }
    const g = geometry(f)
    if (g === previous) continue
    previous = g
    states++
    if (firstSteer !== undefined && f.t < firstSteer) statesBeforeSteer++
    lines.push({ t: f.t, text: `${at(f.t)}  ■ state ${states} st=${f.st}/${f.max}${f.jump ? " JUMP-TO-LATEST" : ""}${f.none ? " (no surface)" : f.empty ? " (EMPTY)" : ""}${flags.chrome ? ` chrome=${JSON.stringify(f.chrome)}` : ""}\n${rowsOf(f)}` })
  }
  lines.sort((a, b) => a.t - b.t)
  const report = `${lines.map((l) => l.text).join("\n")}\n\ngeometry states after the action: ${states}${firstSteer === undefined ? "" : ` (before the first steer: ${statesBeforeSteer}, from it: ${states - statesBeforeSteer})`}\nWorking row: ${workingFlips.join(", ") || (before && working(before) ? "shown throughout" : "never shown")}\nopacity changes: ${opacityFlips}\nrail states: ${railStates}\nside states: ${sideStates}\nside groups moved by another's change: ${sideStandingMoves}\nflash frames: ${flashFrames}\ntail gap at end: ${(() => { const last = frames.filter((f) => !f.none).pop(); return last ? `${last.max - last.st}px` : "(no surface)" })()}\n${anchorReport.map((l) => `${l}\n`).join("")}painted frames: ${painted.length} in ${outDir}/frames\npage errors: ${JSON.stringify(errors.filter((e) => !e.includes("404")).slice(0, 4))}\n`
  writeFileSync(join(outDir, "timeline.txt"), report)
  console.log(report)
} finally {
  await browser.close()
}
