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
/** A thread on its board (in the pane), or with `full` its full-screen page. */
const thread = (project, slug, full = false) => full ? `${base}/project/${project}/thread/${slug}` : `${base}/project/${project}?thread=${slug}`
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

// A pointing hand, original artwork, drawn with its fingertip on the real mouse position: everything a shot
// points at is clickable, and the arrow read as a mouse resting on nothing.
const HAND = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="28" viewBox="0 0 24 28"><path d="M7.6 3.2c0-1 .8-1.8 1.7-1.8s1.7.8 1.7 1.8v7.4c.35-.2.75-.3 1.15-.3.8 0 1.5.45 1.85 1.1.35-.2.75-.3 1.15-.3.95 0 1.75.6 2 1.45.3-.15.6-.2.95-.2 1.15 0 2.05.95 2.05 2.1v4.4c0 4.1-2.7 7.65-6.9 7.65h-1.6c-2.35 0-4-.95-5.4-2.7L1.9 18.4c-.7-.85-.6-2.05.2-2.75.8-.7 2-.6 2.7.2l2.8 3.1z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/><path d="M11 13.4v4.4M14 13.8v4M17.1 14.6v3.2" fill="none" stroke="#111" stroke-width="1.1" stroke-linecap="round"/></svg>`
async function pointAt(page, target, fx = 0.62, fy = 0.72) {
  const box = await target.boundingBox()
  const x = box.x + box.width * fx, y = box.y + box.height * fy
  await page.mouse.move(x, y, { steps: 6 })
  await page.evaluate((x, y, svg) => {
    const el = document.createElement("div")
    el.style.cssText = `position:fixed;left:${x - 9.3}px;top:${y - 1.6}px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))`
    el.innerHTML = svg
    document.body.appendChild(el)
  }, x, y, HAND)
}
const byText = async (page, selector, text) => {
  for (const h of await page.$$(selector)) if (((await h.evaluate((e) => e.textContent)) || "").includes(text)) return h
  throw new Error(`no ${selector} containing ${text}`)
}
const need = async (page, selector, timeout = 15_000) => {
  await page.waitForSelector(selector, { timeout })
  return page.$(selector)
}
/** Narrows a clip from both sides: a box's padded clip otherwise takes in the border of the column around it. */
const inset = (clip, by) => ({ ...clip, x: clip.x + by, width: clip.width - by * 2 })
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
/** The rail and the sidebar, up to the pane's edge beside them. */
const leftPanel = (page, height) => page.evaluate((height) => {
  const sidebar = document.querySelector("[data-pane-sidebar]").getBoundingClientRect()
  return { x: 0, y: 0, width: Math.round(sidebar.right), height }
}, height)

/** The thread the board's pane is showing. */
const PANE = "[data-pane-thread]"
/** The newest message in the transcript, with a little of the page around it. `height` evens up two shots that sit side by side. */
const lastMessage = async (page, height) => {
  await page.evaluate(() => [...document.querySelectorAll("[data-frizz-msg]")].at(-1).setAttribute("data-shot", ""))
  const clip = await around(page, ["[data-shot]"], 14)
  return { ...clip, height: Math.max(clip.height, height) }
}

/** The hero thread open in the pane, with an answer picked and a note typed: the state several shots start from. */
async function stageAnswer(page) {
  await page.goto(thread(API, "settings-store"), { waitUntil: "networkidle2" })
  await need(page, `${PANE} [data-question-option]`)
  // The sign-in hint toasts over the pane's prompt box, which the card's never reached.
  await settle(SIGN_IN_TOAST)
  await hideLoadEarlier(page)
  await (await byText(page, `${PANE} [data-question-option]`, "SQLite")).click()
  await (await need(page, `${PANE} [data-composer-box] textarea`)).click()
  await page.keyboard.type("Use the sessions database, and write through a transaction so a crash can't leave it half-saved.")
  await settle(400)
}
/** Waits for the other projects' counts to reach the rail. */
const railCounts = (page) => page.waitForFunction(() => document.querySelectorAll('[aria-label$="in the queue"]').length >= 3, { timeout: 15_000 }).catch(() => {})

const HERO = {
  hero: { w: 1440, h: 900, stage: async (page) => {
    await stageAnswer(page)
    await (await page.$('section[aria-label="Snoozed"] button'))?.click()
    await pointAt(page, await need(page, `${PANE} button[aria-label="Send"]`), 0.82, 0.78)
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
        rail: at(document.querySelector("[data-focus-rail]")),
        subAgents: at(text("[data-focus-rail] *", "Audit every reader of the settings store")),
        send: at(document.querySelector('[data-pane-thread] button[aria-label="Send"]')),
      }
    })))
  } },
  "f-full": { w: 1440, h: 860, stage: async (page) => {
    await page.goto(thread(API, "settings-store", true), { waitUntil: "networkidle2" })
    await need(page, "[data-focus-rail]")
    await settle(1800)
    await hideLoadEarlier(page)
  } },
  // Every project's queue down the sidebar, and one of their threads open in the pane beside it.
  "f-console": { w: 1440, h: 860, stage: async (page) => {
    await page.goto(`${base}/console`, { waitUntil: "networkidle2" })
    await settle(SIGN_IN_TOAST)
    await (await byText(page, "[data-pane-sidebar] [data-sidebar-item] button", "Persist the settings store")).click()
    await need(page, `${PANE} [data-question-option]`)
    await settle(1800)
    await hideLoadEarlier(page)
    await page.mouse.move(4, 4)
    // The click leaves focus on the row, which keeps its pin and expand marks drawn over the title.
    await page.evaluate(() => document.activeElement?.blur())
    await settle(400)
  } },
  // The whole window, with the pointer on one project and that project's tooltip open.
  "f-home": { w: 1100, h: 580, stage: async (page) => {
    await page.goto(`${base}/`, { waitUntil: "networkidle2" })
    await need(page, "[data-home-grid]")
    await settle(1500)
    await railCounts(page)
    await pointAt(page, await need(page, `[data-home-tile-square][href$="/${API}"]`), 0.36, 0.5)
    await settle(700)
  } },
  // The new-thread box and the whole menu under it, without the rail or the card beside them.
  "f-picker": { w: 1440, h: 900, stage: async (page) => {
    await page.goto(`${base}/project/${API}`, { waitUntil: "networkidle2" })
    await settle(SIGN_IN_TOAST)
    await (await need(page, ".profile-grid-trigger")).click()
    await need(page, ".profile-grid-menu")
    await settle(600)
    return page.evaluate(() => {
      const menu = document.querySelector(".profile-grid-menu")
      // The real menu scrolls inside 360px, which cuts its last row in half. Three Codex models fit it whole.
      const codex = [...menu.querySelectorAll("[data-profile-grid-row]")].filter((row) => /^gpt/i.test(row.dataset.profileGridRow))
      for (const row of codex.slice(3)) row.style.display = "none"
      // ACP agents are whichever CLIs this Mac has on PATH, and this row is about Claude Code and Codex.
      for (const group of menu.querySelectorAll('[role="group"]')) if (group.querySelector('[data-profile-grid-row^="acp:"]')) {
        group.style.display = "none"
        group.previousElementSibling?.querySelector('[role="separator"]')?.style.setProperty("display", "none")
      }
      menu.style.maxHeight = "none"
      // The box and its menu alone: what sits under the box in the panel would otherwise show around the menu.
      const form = document.querySelector(".profile-grid-trigger").closest("form, [data-composer-box]")
      for (let el = form; el.parentElement !== document.body; el = el.parentElement) for (let next = el.nextElementSibling; next; next = next.nextElementSibling) next.style.visibility = "hidden"
      const box = form.getBoundingClientRect(), list = menu.getBoundingClientRect()
      const left = Math.max(0, Math.min(box.left, list.left) - 20), top = Math.min(box.top, list.top) - 14
      return { x: left, y: top, width: Math.max(box.right, list.right) + 20 - left, height: Math.max(box.bottom, list.bottom) + 20 - top }
    })
  } },
  // One project with no column of the others: the project sidebar off, which is the app's default. The scene
  // turns it on for every other shot, so this one answers the setting's read from here.
  "f-workspace": { w: 1440, h: 860, stage: async (page) => {
    await page.evaluateOnNewDocument(() => {
      const real = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const res = await real(input, init)
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
        if (!url.pathname.endsWith("/rpc/settingsGet")) return res
        const { result } = await res.json()
        return new Response(JSON.stringify({ result: { ...result, projectRail: false } }), { headers: { "content-type": "application/json" } })
      }
    })
    await stageAnswer(page)
    await page.mouse.move(4, 4)
    await settle(SIGN_IN_TOAST)
  } },
  "f-github": { w: 860, h: 640, stage: async (page) => {
    // A sandbox has no GitHub sign-in, so the picker's two reads answer from here. The picker itself is real.
    await page.evaluateOnNewDocument((rows) => {
      const real = window.fetch.bind(window)
      const reply = (result) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
        if (url.pathname.endsWith("/rpc/githubStatus")) return reply({ inRepo: true, authed: true, nameWithOwner: "acme/acme-api" })
        if (url.pathname.endsWith("/rpc/githubList")) {
          const hour = 3_600_000
          const items = rows.map(([number, title, author, comments, reactions, label, pr], i) => ({
            kind: "issue", number, title, url: `https://github.com/acme/acme-api/issues/${number}`, state: "OPEN", author,
            createdAt: new Date(Date.now() - (i + 2) * 9 * hour).toISOString(), updatedAt: new Date(Date.now() - (i + 1) * 3 * hour).toISOString(),
            labels: label ? [{ name: label[0], color: label[1] }] : [], comments, reactions,
            ...(pr ? { linkedPrs: { count: 1, number: pr, url: `https://github.com/acme/acme-api/pull/${pr}`, state: "OPEN" } } : {}),
          }))
          return reply({ items, total: items.length, page: 1, pageCount: 1 })
        }
        return real(input, init)
      }
    }, [
      [412, "Rate limiter ignores the per-key override", "dana-k", 6, 4, ["bug", "d73a4a"]],
      [409, "Add cursor pagination to /v2/events", "mhughes", 3, 11, ["enhancement", "a2eeef"], 418],
      [407, "Webhook retries stop after a 502", "tobiaso", 9, 2, ["bug", "d73a4a"]],
      [400, "Document the idempotency header", "dana-k", 1, 0, ["docs", "0075ca"]],
      [398, "Receipt bus test times out on CI", "ravi-p", 4, 1, ["flaky", "fbca04"], 416],
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
  await page.goto(thread(APP, slug, true), { waitUntil: "networkidle2" })
  await need(page, selector ?? "[data-composer-box]", 20_000)
  await settle(1800)
  await hideLoadEarlier(page)
}

const FEATURES = {
  // 1680 wide: the pane's sidebar reaches its full 480px there, and 1440 squeezes it to 323.
  "f-queue": { w: 1680, h: 560, stage: async (page) => {
    await page.goto(`${base}/project/${APP}`, { waitUntil: "networkidle2" })
    await need(page, "[data-pane-sidebar] [data-sidebar-item]")
    await settle(2500)
    await railCounts(page)
    // A project on the rail, with the pointer on it: its tooltip names what it has waiting and running.
    await pointAt(page, await need(page, `a[aria-current="page"][href$="/project/${APP}"]`), 0.42, 0.5)
    await settle(1500)
    return leftPanel(page, 560)
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
  // The parent's option is picked, so the question that hangs on it has opened.
  "f-followup": { w: THREAD_W, h: 900, stage: async (page) => {
    await open(page, "crash-reports", "[data-question-id]")
    await (await byText(page, "[data-question-option]", "A hosted service")).click()
    await settle(600)
    await pointAt(page, await byText(page, "[data-question-option]", "Sentry"), 0.72, 0.62)
    await settle(500)
    return around(page, ["[data-question-id]"], 14)
  } },
  "f-multi": { w: THREAD_W, h: 650, stage: async (page) => {
    await open(page, "release-gates", "[data-question-id]")
    for (const label of ["Unit tests", "End-to-end tests", "Bundle size budget"]) await (await byText(page, "[data-question-option]", label)).click()
    await page.mouse.move(10, 10)
    await settle(500)
  } },
  // A resting thread: the wake from its monitor above, and the monitor still listed on the card.
  "f-monitor": { w: THREAD_W, h: 600, stage: async (page) => {
    await open(page, "watch-production", "[data-awaiting-background]")
    await settle(600)
  } },
  // An agent's reply with its row of images, the pointer on one: what a gallery looks like in the chat.
  "f-gallery": { w: THREAD_W, h: 640, stage: async (page) => {
    await open(page, "billing-gallery", "[data-lightbox-gallery]")
    await pointAt(page, await need(page, "[data-lightbox-tile]"), 0.55, 0.6)
    await settle(500)
    return page.evaluate(() => {
      const gallery = document.querySelector("[data-lightbox-gallery]")
      const reply = gallery.closest("[data-frizz-msg]").getBoundingClientRect(), top = reply.top - 14
      return { x: reply.left - 14, y: top, width: reply.width + 28, height: gallery.getBoundingClientRect().bottom + 14 - top }
    })
  } },
  "f-md-code": { w: 780, h: 900, stage: async (page) => { await open(page, "md-code"); return lastMessage(page, 360) } },
  "f-md-diff": { w: 780, h: 900, stage: async (page) => { await open(page, "md-diff"); return lastMessage(page, 250) } },
  "f-md-callouts": { w: 780, h: 900, stage: async (page) => { await open(page, "md-callouts"); return lastMessage(page, 250) } },
  "f-md-ansi": { w: 780, h: 900, stage: async (page) => { await open(page, "md-ansi"); return lastMessage(page, 194) } },
  "f-md-tasks": { w: 780, h: 900, stage: async (page) => { await open(page, "md-tasks"); return lastMessage(page, 194) } },
  "f-md-diagram": { w: 780, h: 900, stage: async (page) => { await open(page, "md-diagram", '[data-mermaid-state="ready"]'); return lastMessage(page, 360) } },
  "f-wait": { w: THREAD_W, h: 600, stage: async (page) => {
    await open(page, "load-test", "[data-awaiting-background]")
    await settle(600)
  } },
  "f-options": { w: THREAD_W, h: 1040, stage: async (page) => {
    await open(page, "billing-layout", "[data-question-id]")
    // Its label, not its middle: the middle of this option is a picture, and a click there opens it.
    const option = await (await byText(page, "[data-question-option]", "Two columns")).boundingBox()
    await page.mouse.click(option.x + 70, option.y + 20)
    await page.mouse.move(10, 10)
    await settle(500)
    // The card alone, cut off partway down its second option: whole, it is the tallest shot on the page.
    const card = await around(page, ["[data-question-id]"], 14)
    return { ...card, height: Math.min(card.height, card.width * 0.68) }
  } },
  "f-steps": { w: THREAD_W, h: 520, stage: async (page) => {
    await open(page, "publish-docs", "[data-awaiting-steps]")
    // A tick is saved on the server, so a second shoot of one stack finds it already there.
    const box = await need(page, "[data-awaiting-steps] li:first-child button[role=checkbox]")
    if (await box.evaluate((el) => el.getAttribute("aria-checked") === "false")) await box.click()
    await page.mouse.move(10, 10)
    await settle(400)
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
  "f-watch": { w: THREAD_W, h: 620, stage: async (page) => {
    await open(page, "ship-sync", "[data-awaiting-background]")
  } },
  // One PR from opened to merged, with every wake the watcher sent on the way.
  "f-pr-life": { w: 920, h: 820, stage: async (page) => {
    await open(page, "pr-life")
    const bottom = await page.evaluate(() => [...document.querySelectorAll("[data-frizz-msg]")].at(-1).getBoundingClientRect().bottom)
    return { x: 0, y: 0, width: 920, height: Math.round(bottom) + 16 }
  } },
  "f-issue": { w: THREAD_W, h: 640, stage: async (page) => {
    await open(page, "issue-wait", "[data-awaiting-background]")
  } },
  // The snooze on a card that is waiting on GitHub, whose own line says what brings it back.
  "f-snooze-pr": { w: THREAD_W, h: 560, stage: async (page) => {
    await open(page, "ship-sync", "[data-awaiting-background]")
    await pointAt(page, await need(page, "[data-awaiting-snooze] button"), 0.7, 0.75)
    await settle(400)
    return around(page, ["[data-awaiting-background]"], 18)
  } },
  // The card's data is answered here, since a sandbox has no GitHub sign-in. The hovercard itself is real.
  "f-hovercard": { w: THREAD_W, h: 520, stage: async (page) => {
    await page.evaluateOnNewDocument((card) => {
      const real = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
        if (url.pathname.endsWith("/rpc/githubRefPreview")) return new Response(JSON.stringify({ result: { cards: [{ ...card, fetchedAt: Date.now(), at: new Date(Date.now() - 5 * 3_600_000).toISOString() }], missing: [] } }), { headers: { "content-type": "application/json" } })
        return real(input, init)
      }
    }, {
      ref: "acme/mobile-app#392", kind: "pr", repo: "acme/mobile-app", url: "https://github.com/acme/mobile-app/pull/392",
      title: "Stop retrying after the connection closes",
      body: "A retry could fire after the socket had already closed, which crashed the sync worker on some devices and stalled it on others. Retries now check the connection first and stop at the limit in config.",
      state: "OPEN", authorLogin: "dana-k", labels: [{ name: "bug", color: "d73a4a" }, { name: "sync", color: "0e8a16" }],
      additions: 84, deletions: 12, changedFiles: 5, comments: 3,
    })
    await open(page, "hover-refs")
    const link = await need(page, 'a[data-gh-ref="acme/mobile-app#392"]')
    const box = await link.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
    await need(page, "[data-radix-popper-content-wrapper]")
    await settle(700)
    await pointAt(page, link, 0.5, 0.7)
    await settle(200)
  } },
  // The rail beside a full-screen thread, in the whole window. dist/bundle.js was written too, and git ignores it.
  // The rail's edited-files panel on its own, with the pointer on a file.
  "f-edited": { w: 1280, h: 620, stage: async (page) => {
    await open(page, "edited-rail", "[data-edited-file-tree]")
    await pointAt(page, await byText(page, "[data-edited-file-tree] a, [data-edited-file-tree] button", "retry.ts"), 0.5, 0.62)
    await settle(400)
    return page.evaluate(() => {
      const rail = document.querySelector("[data-focus-rail]").getBoundingClientRect(), tree = document.querySelector("[data-edited-file-tree]").getBoundingClientRect()
      const top = tree.top - 44
      return { x: rail.left, y: top, width: rail.width, height: tree.bottom + 20 - top }
    })
  } },
  // The sheet the GitHub button opens while Frizz is signed out, over the board. The code is made up; the sheet is real.
  "f-signin": { w: 880, h: 580, stage: async (page) => {
    await page.evaluateOnNewDocument(() => {
      const real = window.fetch.bind(window)
      const reply = (result) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
        if (url.pathname.endsWith("/rpc/githubStatus")) return reply({ inRepo: true, authed: false, nameWithOwner: "acme/mobile-app" })
        if (url.pathname.endsWith("/rpc/githubAccount")) return reply({ signedIn: false, source: "none", appRegistered: true, signIn: { phase: "pending", userCode: "F7QK-29XD", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900_000 } })
        return real(input, init)
      }
    })
    await page.goto(`${base}/project/${APP}`, { waitUntil: "networkidle2" })
    await settle(SIGN_IN_TOAST)
    await (await need(page, '[data-github-trigger], button[aria-label*="GitHub"], button[aria-label*="issues"]')).click()
    await need(page, "[data-github-device-code]")
    await settle(500)
    await pointAt(page, await byText(page, "[data-github-sign-in] a", "Copy code and open GitHub"), 0.86, 0.66)
    await settle(400)
  } },
  // Five helpers on one card, with the pointer on a row: each opens that helper's live transcript. Above the
  // message, the transcript lists the same five as tool calls, so the shot stops at the message.
  "f-subagent": { w: THREAD_W, h: 640, stage: async (page) => {
    await open(page, "fleet", "[data-awaiting-background]")
    await settle(600)
    await pointAt(page, await byText(page, "[data-awaiting-background] [data-wait-row], [data-awaiting-background] button", "Reproduce the stall"), 0.42, 0.62)
    await settle(400)
    await page.evaluate(() => [...document.querySelectorAll("[data-frizz-msg]")].at(-1).setAttribute("data-shot", ""))
    return around(page, ["[data-shot]", "[data-awaiting-background]"], 18)
  } },
  "f-goal": { w: THREAD_W, h: 610, stage: async (page) => {
    await open(page, "green-suite")
    await (await need(page, "[data-recurring-prompt]")).click()
    await need(page, "[data-recurring-panel]")
    await settle(600)
    await pointAt(page, await need(page, "[data-recurring-prompt]"), 0.5, 0.62)
    await settle(300)
    return inset(await around(page, ["[data-recurring-panel]", "[data-composer-box]"], 16), 6)
  } },
  "f-steer": { w: THREAD_W, h: 400, stage: async (page) => {
    await open(page, "steer-running")
    await (await need(page, "[data-composer-box] textarea")).click()
    await page.keyboard.type("Keep the system setting as the default.")
    await (await need(page, "[data-send-menu]")).click()
    await need(page, "[data-send-modes]")
    await settle(500)
    await pointAt(page, await byText(page, "[data-send-modes] button, [data-send-modes] [role^='menuitem']", "Send as steer"), 0.84, 0.45)
    await settle(300)
    await page.evaluate(() => [...document.querySelectorAll("button, [role='button'], span, div")].filter((e) => (e.textContent || "").trim().startsWith("Running the UI tests")).at(-1).setAttribute("data-shot", ""))
    return inset(await around(page, ["[data-shot]", "[data-send-modes]", "[data-composer-box]"], 16), 6)
  } },
  "f-peer": { w: THREAD_W, h: 684, stage: async (page) => {
    await open(page, "peer-message", "[data-session-message-toggle]")
    await (await page.$("[data-session-message-toggle]")).click()
    await settle(500)
  } },
  // Working through a doc: one passage already referenced in the reply with a comment beside it, the next one selected.
  "f-reader": { w: 1440, h: 860, stage: async (page) => {
    await open(page, "sync-design")
    await (await byText(page, "a, button", "sync design doc")).click()
    await need(page, "[data-file-viewer-panel]")
    await settle(2000)
    const select = (text) => page.evaluate((text) => {
      const panel = document.querySelector("[data-file-viewer-panel]")
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(text)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + text.length)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        const r = range.getBoundingClientRect()
        return { x: r.left, y: r.top, width: r.width, height: r.height }
      }
      throw new Error(`no ${text} in the reader`)
    }, text)
    const line = "Every write carries the server revision it was based on."
    await select(line)
    await page.keyboard.down("Meta")
    await page.keyboard.press("i")
    await page.keyboard.up("Meta")
    await settle(500)
    await page.keyboard.type(" What about a client that never reconnects?")
    await settle(300)
    // ⌘I collapses the selection. Select the line again, so the shot shows which line the reference names,
    // with the pointer in the chat, where the comment is going.
    await select(line)
    await pointAt(page, await need(page, '[data-composer-box] button[aria-label="Send"]'), 0.84, 0.72)
    await settle(300)
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
      // A clip captures beyond the viewport by default, which resizes the page and closes an open tooltip.
      await page.screenshot({ path: join(outDir, `${name}.png`), ...(clip ? { clip, captureBeyondViewport: false } : {}) })
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
