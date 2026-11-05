// Photograph the frizz.sh screenshots from a stack seeded by scripts/seed-site-scene.mjs.
//
//   nub scripts/shoot-site.mjs --stack=<file holding adhoc-stack's json line> --out=<dir> --set=hero|features [--only=a,b] [--dsf=2]
//
// Each shot is the real app in a real browser, driven the way a person would: a click to pick an answer,
// keystrokes in the box, the pointer resting on a control. The one thing added is the pointer itself,
// since a screenshot has none: it is drawn at the mouse's real position.
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

/** Hides everything on the page but one panel, so the crop around it shows no page behind it. */
const keepOnly = (page, selector) => page.evaluate((selector) => {
  const panel = document.querySelector(selector)
  for (let el = panel; el !== document.body; el = el.parentElement) {
    for (const sibling of el.parentElement.children) if (sibling !== el) sibling.style.visibility = "hidden"
    if (el !== panel) el.style.cssText += ";background:transparent !important;border-color:transparent !important;box-shadow:none !important;backdrop-filter:none !important"
  }
}, selector)

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
  "f-question": { w: 1440, h: 900, stage: async (page) => {
    await stageAnswer(page)
    return around(page, [`${CARD("settings-store")} [data-question-id]`, `${CARD("settings-store")} [data-composer-box]`], 14)
  } },
  "f-ops": { w: 1440, h: 900, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await need(page, CARD("settings-store"))
    await settle(1500)
    await page.addStyleTag({ content: "[data-question-id] { visibility: hidden }" })
    await pointAt(page, await need(page, `${CARD("settings-store")} [data-ops-count="shell"]`), 0.7, 0.8)
    await settle(700)
    return around(page, [`${CARD("settings-store")} [data-queue-ops-summary]`, "[data-queue-ops-panel]", `${CARD("settings-store")} [data-composer-box]`], 14)
  } },
  "f-subagent": { w: 1440, h: 620, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await need(page, CARD("settings-store"))
    await settle(1500)
    await (await need(page, `${CARD("settings-store")} [data-ops-count="agent"]`)).hover()
    await settle(400)
    await (await byText(page, '[data-queue-ops-panel="agent"] button, [data-queue-ops-panel="agent"] [role="button"]', "Audit every reader")).click()
    await need(page, "[data-subagent-header]")
    await page.mouse.move(40, 40)
    await settle(1500)
    return around(page, ["[data-subagent-header]"], 0).then((head) => ({ x: head.x, y: 0, width: head.width, height: 620 }))
  } },
  "f-full": { w: 1600, h: 1000, stage: async (page) => {
    await page.goto(thread(API, "settings-store", "/full"), { waitUntil: "networkidle2" })
    await need(page, "[data-focus-rail]")
    await settle(1800)
    // The column and its rail, without the empty margins a wide window leaves around them.
    return page.evaluate(() => {
      const rail = document.querySelector("[data-focus-rail]").getBoundingClientRect()
      const left = rail.left - 728
      return { x: left, y: 0, width: rail.right + 8 - left, height: 720 }
    })
  } },
  "f-console": { w: 1440, h: 900, stage: async (page) => {
    await page.goto(`${base}/console`, { waitUntil: "networkidle2" })
    await settle(3000)
  } },
  "f-home": { w: 760, h: 700, stage: async (page) => {
    await page.goto(`${base}/`, { waitUntil: "networkidle2" })
    await need(page, "[data-home-grid]")
    await page.addStyleTag({ content: "[data-home-grid] { grid-template-columns: repeat(3, auto) !important; width: max-content !important; margin-inline: auto; column-gap: 28px !important }" })
    await settle(1500)
    await railCounts(page)
    return around(page, ["[data-home-grid]"], 40)
  } },
  "f-picker": { w: 1440, h: 1500, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await settle(1500)
    await (await need(page, ".profile-grid-trigger")).click()
    await need(page, ".profile-grid-menu")
    await keepOnly(page, ".profile-grid-menu")
    await settle(600)
    return around(page, [".profile-grid-menu"], 16)
  } },
  "f-github": { w: 1200, h: 820, stage: async (page) => {
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
    await keepOnly(page, ".shadow-2xl:has([data-row-number])")
    await settle(400)
    return page.evaluate(() => {
      const r = document.querySelector("[data-row-number]").closest(".shadow-2xl").getBoundingClientRect()
      return { x: r.left - 16, y: r.top - 16, width: r.width + 32, height: r.height + 32 }
    })
  } },
  "f-phone-board": { w: 390, h: 844, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await settle(2500)
  } },
  "f-phone-question": { w: 390, h: 844, stage: async (page) => {
    await page.goto(thread(API, "settings-store"), { waitUntil: "networkidle2" })
    await settle(2500)
    await (await byText(page, "button", "Answer")).click()
    await settle(1200)
  } },
}

// Each opens on the thread's own full page, where no other card can scroll in over the one being shot.
const open = async (page, slug, selector) => {
  await page.goto(thread(APP, slug, "/full"), { waitUntil: "networkidle2" })
  await need(page, selector ?? "[data-composer-box]", 20_000)
  await settle(1800)
  await hideLoadEarlier(page)
}
/** The thread's column, from a top to a bottom, so a shot keeps its surroundings at their real width. */
const column = (page, top, bottom) => page.evaluate((top, bottom) => {
  const box = document.querySelector("[data-composer-box]").getBoundingClientRect()
  return { x: box.left - 8, y: top, width: box.width + 16, height: bottom - top }
}, top, bottom)

const FEATURES = {
  "f-wait": { w: 1440, h: 900, stage: async (page) => {
    await open(page, "load-test", "[data-awaiting-background]")
    await settle(600)
    const card = await around(page, ["[data-awaiting-background]"], 0)
    return column(page, card.y - 96, card.y + card.height + 18)
  } },
  "f-options": { w: 1440, h: 1300, stage: async (page) => {
    await open(page, "billing-layout", "[data-question-id]")
    // Its label, not its middle: the middle of this option is a picture, and a click there opens it.
    const option = await (await byText(page, "[data-question-option]", "Two columns")).boundingBox()
    await page.mouse.click(option.x + 70, option.y + 20)
    await page.mouse.move(10, 10)
    await settle(500)
    return around(page, ["[data-question-id]"], 14)
  } },
  "f-steps": { w: 1440, h: 1000, stage: async (page) => {
    await open(page, "publish-docs", "[data-awaiting-steps]")
    const steps = await around(page, ["[data-awaiting-steps]", "[data-steps-complete]"], 0)
    return column(page, steps.y - 120, steps.y + steps.height + 20)
  } },
  "f-secret": { w: 1440, h: 900, stage: async (page) => {
    await open(page, "publish-sdk", "[data-question-id]")
    return around(page, ["[data-question-id]"], 14)
  } },
  "f-snooze": { w: 1440, h: 900, stage: async (page) => {
    await open(page, "offline-sync")
    await (await need(page, "[data-snooze-menu]")).click()
    await need(page, '[role="menu"]')
    await settle(500)
    // Down to the end of the card behind the menu, so nothing is cut off mid-card.
    const button = await byText(page, "button", "Mark as done")
    const box = await button.boundingBox()
    return column(page, 0, box.y + box.height + 32)
  } },
  "f-watch": { w: 1440, h: 1000, stage: async (page) => {
    await open(page, "ship-sync", "[data-awaiting-background]")
    const card = await around(page, ["[data-awaiting-background]"], 0)
    return column(page, 0, card.y + card.height + 18)
  } },
  "f-goal": { w: 1440, h: 1000, stage: async (page) => {
    await open(page, "green-suite")
    await (await need(page, "[data-recurring-prompt]")).click()
    await need(page, "[data-recurring-panel]")
    await settle(600)
    const box = await around(page, ["[data-composer-box]", "[data-recurring-panel]"], 14)
    return column(page, box.y, box.y + box.height)
  } },
  "f-steer": { w: 1440, h: 900, stage: async (page) => {
    await open(page, "steer-running")
    await (await need(page, "[data-composer-box] textarea")).click()
    await page.keyboard.type("Keep the system setting as the default.")
    await (await need(page, "[data-send-menu]")).click()
    await need(page, "[data-send-modes]")
    await settle(500)
    const box = await around(page, ["[data-composer-box]", "[data-send-modes]"], 14)
    return column(page, box.y, box.y + box.height)
  } },
  "f-peer": { w: 1440, h: 1000, stage: async (page) => {
    await open(page, "peer-message", "[data-session-message-toggle]")
    await (await page.$("[data-session-message-toggle]")).click()
    await settle(500)
    const line = await around(page, ["[data-session-message-toggle]"], 0)
    return column(page, Math.max(0, line.y - 90), line.y + 330)
  } },
  "f-markdown": { w: 1440, h: 1400, stage: async (page) => {
    await open(page, "retry-report", '[data-mermaid-state="ready"]')
    const [top, bottom] = await page.evaluate(() => {
      const lines = [...document.querySelectorAll(".md-diff-text")]
      return [document.querySelector("[data-frizz-msg] h2, .md-body h2").getBoundingClientRect().top, lines[lines.length - 1].getBoundingClientRect().bottom]
    })
    return column(page, top - 10, bottom + 22)
  } },
  "f-gallery": { w: 1440, h: 1000, stage: async (page) => {
    await open(page, "billing-gallery", "[data-lightbox-gallery]")
    await settle(800)
    const gallery = await around(page, ["[data-lightbox-gallery]"], 0)
    return column(page, gallery.y - 46, gallery.y + gallery.height + 18)
  } },
  "f-reader": { w: 1600, h: 1000, stage: async (page) => {
    await open(page, "sync-design")
    await (await byText(page, "a, button", "sync design doc")).click()
    await need(page, "[data-file-viewer-panel]")
    await settle(2000)
    return { x: 0, y: 0, width: 1600, height: 660 }
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
