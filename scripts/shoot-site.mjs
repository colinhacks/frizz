// Photograph the frizz.sh screenshots from a stack seeded by scripts/seed-site-scene.mjs.
//
//   nub scripts/shoot-site.mjs --stack=<file holding adhoc-stack's json line> --out=<dir> --set=hero|features [--only=a,b] [--dsf=2]
//
// Each shot is the real app in a real browser, driven the way a person would: a click to pick an answer,
// keystrokes in the box, the pointer resting on a control. The one thing added is the pointer itself,
// since a screenshot has none: it is drawn at the mouse's real position. A shot is the whole window unless
// its stage returns a clip, so what it features keeps the page around it.
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { launchHeadless } from "./lib/headless-browser.mjs"

const opt = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const stack = JSON.parse(readFileSync(opt("stack"), "utf8").split("\n").find((l) => l.startsWith("{")))
const outDir = opt("out")
const defaultDsf = Number(opt("dsf", "2"))
const set = opt("set", "hero")
const only = opt("only")?.split(",")
mkdirSync(outDir, { recursive: true })
const base = `http://127.0.0.1:${stack.port}`
const API = "acme-api", APP = "mobile-app"
/** Wide enough that a thread's column sits in the window with the page showing on both sides. */
const THREAD_W = 880
const thread = (project, slug, suffix = "") => `${base}/project/${project}/thread/${slug}${suffix}`
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

// An arrow pointer, original artwork, drawn at the real mouse position.
const ARROW = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="26" viewBox="0 0 22 26"><path d="M2.2 1.6v19.2l4.9-4.6 3.1 7.3 3.5-1.5-3.1-7.2h6.8z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`
async function pointAt(page, target, fx = 0.62, fy = 0.72) {
  const box = await target.boundingBox()
  const x = box.x + box.width * fx, y = box.y + box.height * fy
  await page.mouse.move(x, y, { steps: 6 })
  await page.evaluate((x, y, svg) => {
    const el = document.createElement("div")
    el.style.cssText = `position:fixed;left:${x - 2}px;top:${y - 2}px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))`
    el.innerHTML = svg
    document.body.appendChild(el)
  }, x, y, ARROW)
}
const byText = async (page, selector, text) => {
  for (const h of await page.$$(selector)) if (((await h.evaluate((e) => e.textContent)) || "").includes(text)) return h
  throw new Error(`no ${selector} containing ${text}`)
}
const need = async (page, selector, timeout = 15_000) => {
  await page.waitForSelector(selector, { timeout })
  return page.$(selector)
}
const hideLoadEarlier = (page) => page.evaluate(() => {
  for (const b of document.querySelectorAll("button")) if (/Load earlier messages/.test(b.textContent || "")) b.style.display = "none"
})
/** The box around every selector that matches, padded. */
const around = (page, selectors, pad = 16) => page.evaluate((selectors, pad) => {
  const rects = selectors.flatMap((s) => [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect())).filter((r) => r.width && r.height)
  if (!rects.length) throw new Error(`nothing matches ${selectors}`)
  const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - pad), top = Math.max(0, Math.min(...rects.map((r) => r.top)) - pad)
  const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + pad), bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)) + pad)
  return { x: left, y: top, width: right - left, height: bottom - top }
}, selectors, pad)

/** The app's sign-in hint lasts 6s on a project page, and a sandbox has no GitHub sign-in. */
const SIGN_IN_TOAST = 6500
/** The rail and left panel, up to the first card beside them. */
const leftPanel = (page, height) => page.evaluate((height) => {
  const card = document.querySelector("[data-queue-card-root]").getBoundingClientRect()
  return { x: 0, y: 0, width: Math.round(card.left - 16), height }
}, height)

const CARD = (slug) => `[data-queue-card-root="${slug}"]`

/** The hero thread with an answer picked and a note typed: the state several shots start from. */
async function stageAnswer(page) {
  await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
  await need(page, CARD("settings-store"))
  await settle(1800)
  await hideLoadEarlier(page)
  await (await byText(page, `${CARD("settings-store")} [data-question-option]`, "SQLite")).click()
  await (await need(page, `${CARD("settings-store")} [data-composer-box] textarea`)).click()
  await page.keyboard.type("Use the sessions database, and write through a transaction so a crash can't leave it half-saved.")
  await settle(400)
}
/** Waits for the other projects' counts to reach the rail. */
const railCounts = (page) => page.waitForFunction(() => document.querySelectorAll('[aria-label$="in the queue"]').length >= 3, { timeout: 15_000 }).catch(() => {})

const HERO = {
  hero: { w: 1440, h: 900, stage: async (page) => {
    await stageAnswer(page)
    await (await page.$('section[aria-label="Snoozed"] button'))?.click()
    await pointAt(page, await need(page, `${CARD("settings-store")} [data-ops-count="agent"]`), 0.7, 0.8)
    await settle(1200)
    // Where the page's callouts point, as percentages of the shot.
    console.log("callouts", JSON.stringify(await page.evaluate(() => {
      const at = (el) => { const r = el.getBoundingClientRect(); return { l: +(r.left / innerWidth * 100).toFixed(1), r: +(r.right / innerWidth * 100).toFixed(1), t: +(r.top / innerHeight * 100).toFixed(1), b: +(r.bottom / innerHeight * 100).toFixed(1) } }
      const text = (sel, t) => [...document.querySelectorAll(sel)].find((e) => (e.textContent || "").includes(t))
      return {
        snoozedBand: at(document.querySelector('section[aria-label="Snoozed"]')),
        queueRow: at(text("a, button, [role='button'], li", "Persist the settings store across restarts")),
        steer: at(text('[data-frizz-msg]', "Keep it readable")),
        option: at(text("[data-question-option]", "SQLite")),
        ops: at(document.querySelector('[data-queue-card-root="settings-store"] [data-queue-ops-summary]')),
        send: at(document.querySelector('[data-queue-card-root="settings-store"] button[aria-label="Send"]')),
      }
    })))
  } },
  "hero-send": { w: 1440, h: 900, stage: async (page) => {
    await stageAnswer(page)
    await (await page.$('section[aria-label="Snoozed"] button'))?.click()
    await pointAt(page, await need(page, `${CARD("settings-store")} button[aria-label="Send"]`), 0.82, 0.78)
    await settle(1200)
  } },
  "f-ops": { w: THREAD_W, h: 690, stage: async (page) => {
    await page.goto(thread(API, "settings-store", "/full"), { waitUntil: "networkidle2" })
    await need(page, "[data-queue-ops-summary]")
    await settle(1800)
    await hideLoadEarlier(page)
    await pointAt(page, await need(page, '[data-ops-count="shell"]'), 0.7, 0.8)
    await settle(700)
  } },
  "f-subagent": { w: 1180, h: 600, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await need(page, CARD("settings-store"))
    await settle(1500)
    await (await need(page, `${CARD("settings-store")} [data-ops-count="agent"]`)).hover()
    await settle(400)
    await (await byText(page, '[data-queue-ops-panel="agent"] button, [data-queue-ops-panel="agent"] [role="button"]', "Audit every reader")).click()
    await need(page, "[data-subagent-header]")
    await page.mouse.move(40, 40)
    await settle(SIGN_IN_TOAST)
    // The drawer, with a strip of the dimmed board beside it.
    const head = await around(page, ["[data-subagent-header]"], 0)
    return { x: Math.max(0, head.x - 64), y: 0, width: Math.min(1180, head.x + head.width) - Math.max(0, head.x - 64), height: 600 }
  } },
  "f-full": { w: 1440, h: 890, stage: async (page) => {
    await page.goto(thread(API, "settings-store", "/full"), { waitUntil: "networkidle2" })
    await need(page, "[data-focus-rail]")
    await settle(1800)
    await hideLoadEarlier(page)
  } },
  "f-console": { w: 1440, h: 900, stage: async (page) => {
    await page.goto(`${base}/console`, { waitUntil: "networkidle2" })
    await settle(SIGN_IN_TOAST)
  } },
  "f-home": { w: 900, h: 480, stage: async (page) => {
    await page.goto(`${base}/`, { waitUntil: "networkidle2" })
    await need(page, "[data-home-grid]")
    await settle(1500)
    await railCounts(page)
  } },
  "f-picker": { w: 1440, h: 700, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await settle(1500)
    await (await need(page, ".profile-grid-trigger")).click()
    await need(page, ".profile-grid-menu")
    await settle(600)
    return leftPanel(page, 700)
  } },
  "f-github": { w: 860, h: 860, stage: async (page) => {
    // A sandbox has no GitHub sign-in, so the picker's two reads answer from here. The picker itself is real.
    await page.evaluateOnNewDocument((rows) => {
      const real = window.fetch.bind(window)
      const reply = (result) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
        if (url.pathname.endsWith("/rpc/githubStatus")) return reply({ inRepo: true, authed: true, nameWithOwner: "acme/acme-api" })
        if (url.pathname.endsWith("/rpc/githubList")) {
          const hour = 3_600_000
          const items = rows.map(([number, title, author, comments, reactions, label], i) => ({
            kind: "issue", number, title, url: `https://github.com/acme/acme-api/issues/${number}`, state: "OPEN", author,
            createdAt: new Date(Date.now() - (i + 2) * 9 * hour).toISOString(), updatedAt: new Date(Date.now() - (i + 1) * 3 * hour).toISOString(),
            labels: label ? [{ name: label[0], color: label[1] }] : [], comments, reactions,
          }))
          return reply({ items, total: items.length, page: 1, pageCount: 1 })
        }
        return real(input, init)
      }
    }, [
      [412, "Rate limiter ignores the per-key override", "dana-k", 6, 4, ["bug", "d73a4a"]],
      [409, "Add cursor pagination to /v2/events", "mhughes", 3, 11, ["enhancement", "a2eeef"]],
      [407, "Webhook retries stop after a 502", "tobiaso", 9, 2, ["bug", "d73a4a"]],
      [400, "Document the idempotency header", "dana-k", 1, 0, ["docs", "0075ca"]],
      [398, "Receipt bus test times out on CI", "ravi-p", 4, 1, ["flaky", "fbca04"]],
      [395, "CSV export drops rows past 10k", "lenaw", 7, 5, ["bug", "d73a4a"]],
      [390, "Support OIDC for service accounts", "mhughes", 12, 18, ["enhancement", "a2eeef"]],
      [388, "Slow query on the project settings page", "ravi-p", 2, 3, null],
      [381, "Upgrade to Node 24", "tobiaso", 0, 6, null],
      [377, "Audit log misses role changes", "lenaw", 5, 2, ["bug", "d73a4a"]],
    ])
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await settle(1500)
    await (await need(page, '[data-github-trigger], button[aria-label*="GitHub"], button[aria-label*="issues"]')).click()
    await need(page, "[data-row-number]")
    await settle(800)
    for (const n of [412, 407, 395]) await page.click(`[data-row-number="${n}"]`, { offset: { x: 14, y: 14 } })
    await page.mouse.move(4, 4)
    await settle(400)
  } },
  "f-phone-board": { w: 390, h: 844, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await settle(SIGN_IN_TOAST)
  } },
  "f-phone-question": { w: 390, h: 844, stage: async (page) => {
    await page.goto(thread(API, "settings-store"), { waitUntil: "networkidle2" })
    await settle(2500)
    await (await byText(page, "button", "Answer")).click()
    await settle(SIGN_IN_TOAST)
  } },
}

// Each opens on the thread's own full page, where no other card can scroll in over the one being shot. The
// shot is the whole window, so the thread keeps its header, the messages above and the page on either side.
const open = async (page, slug, selector) => {
  await page.goto(thread(APP, slug, "/full"), { waitUntil: "networkidle2" })
  await need(page, selector ?? "[data-composer-box]", 20_000)
  await settle(1800)
  await hideLoadEarlier(page)
}

const FEATURES = {
  "f-queue": { w: 1440, h: 800, stage: async (page) => {
    await page.goto(`${base}/project/${APP}`, { waitUntil: "networkidle2" })
    await need(page, "[data-queue-card-root]")
    await settle(2500)
    return leftPanel(page, 800)
  } },
  "f-question": { w: THREAD_W, h: 548, stage: async (page) => {
    await open(page, "push-provider", "[data-question-id]")
    await (await byText(page, "[data-question-option]", "APNs and FCM")).click()
    await (await need(page, "[data-composer-box] textarea")).click()
    await page.keyboard.type("Keep it behind the notification service, so the vendor can change later.")
    await settle(300)
    await pointAt(page, await need(page, 'button[aria-label="Send"]'), 0.82, 0.78)
    await settle(500)
  } },
  "f-wait": { w: THREAD_W, h: 600, stage: async (page) => {
    await open(page, "load-test", "[data-awaiting-background]")
    await settle(600)
  } },
  "f-options": { w: THREAD_W, h: 1084, stage: async (page) => {
    await open(page, "billing-layout", "[data-question-id]")
    // Its label, not its middle: the middle of this option is a picture, and a click there opens it.
    const option = await (await byText(page, "[data-question-option]", "Two columns")).boundingBox()
    await page.mouse.click(option.x + 70, option.y + 20)
    await page.mouse.move(10, 10)
    await settle(500)
  } },
  "f-steps": { w: THREAD_W, h: 520, stage: async (page) => {
    await open(page, "publish-docs", "[data-awaiting-steps]")
  } },
  "f-secret": { w: THREAD_W, h: 440, stage: async (page) => {
    await open(page, "publish-sdk", "[data-question-id]")
  } },
  "f-snooze": { w: THREAD_W, h: 510, stage: async (page) => {
    await open(page, "offline-sync")
    await (await need(page, "[data-snooze-menu]")).click()
    await need(page, '[role="menu"]')
    await settle(500)
  } },
  "f-watch": { w: THREAD_W, h: 540, stage: async (page) => {
    await open(page, "ship-sync", "[data-awaiting-background]")
  } },
  "f-goal": { w: THREAD_W, h: 610, stage: async (page) => {
    await open(page, "green-suite")
    await (await need(page, "[data-recurring-prompt]")).click()
    await need(page, "[data-recurring-panel]")
    await settle(600)
  } },
  "f-steer": { w: THREAD_W, h: 470, stage: async (page) => {
    await open(page, "steer-running")
    await (await need(page, "[data-composer-box] textarea")).click()
    await page.keyboard.type("Keep the system setting as the default.")
    await (await need(page, "[data-send-menu]")).click()
    await need(page, "[data-send-modes]")
    await settle(500)
  } },
  "f-peer": { w: THREAD_W, h: 684, stage: async (page) => {
    await open(page, "peer-message", "[data-session-message-toggle]")
    await (await page.$("[data-session-message-toggle]")).click()
    await settle(500)
  } },
  "f-markdown": { w: THREAD_W, h: 960, stage: async (page) => {
    await open(page, "retry-report", '[data-mermaid-state="ready"]')
  } },
  "f-gallery": { w: THREAD_W, h: 630, stage: async (page) => {
    await open(page, "billing-gallery", "[data-lightbox-gallery]")
    await settle(800)
  } },
  "f-reader": { w: 1440, h: 760, stage: async (page) => {
    await open(page, "sync-design")
    await (await byText(page, "a, button", "sync design doc")).click()
    await need(page, "[data-file-viewer-panel]")
    await settle(2000)
  } },
}

const SHOTS = set === "features" ? FEATURES : HERO

async function take(name, shot) {
  // A fresh browser per shot: a draft or a collapsed band from the last one must not carry over, and a
  // renderer that dies on one page must not take the rest of the list with it.
  const browser = await launchHeadless({ protocolTimeout: 45_000 })
  try {
    const page = await browser.newPage()
    // The hero's thread has helpers still running, so it is the newest row in the queue.
    await page.evaluateOnNewDocument(() => localStorage.setItem("frizz.prefs.v1", JSON.stringify({ queueOrder: "lifo" })))
    await page.setViewport({ width: shot.w, height: shot.h, deviceScaleFactor: shot.dsf ?? defaultDsf })
    const errors = []
    page.on("pageerror", (e) => errors.push(e.message))
    const work = (async () => {
      const clip = await shot.stage(page)
      await railCounts(page)
      await page.screenshot({ path: join(outDir, `${name}.png`), ...(clip ? { clip } : {}) })
      return clip
    })()
    const clip = await Promise.race([work, settle(70_000).then(() => { throw new Error("timed out after 70s") })])
    console.log(`${name}${clip ? ` ${Math.round(clip.width)}x${Math.round(clip.height)}` : ""}${errors.length ? ` ERRORS ${errors.join(" | ")}` : ""}`)
  } finally {
    // close() can hang once the pages are done, so give it a moment and then end the process it owns.
    await Promise.race([browser.close().catch(() => {}), settle(3000)])
    browser.process()?.kill()
  }
}

let failed = 0
for (const [name, shot] of Object.entries(SHOTS)) {
  if (only && !only.includes(name)) continue
  try {
    await take(name, shot)
  } catch (first) {
    console.log(`${name}: ${first.message}, trying again`)
    try { await take(name, shot) } catch (error) { failed++; console.log(`${name} FAILED: ${error.message}`) }
  }
}
process.exit(failed ? 1 : 0)
