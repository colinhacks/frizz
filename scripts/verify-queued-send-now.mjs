// ONE "SEND NOW" UNDER THE QUEUED MESSAGES — the control that replaced a ↑ beside every queued bubble.
//
// The ↑ grew beside whichever queued bubble was under the pointer, though it always sent the WHOLE
// queue, and a message sent to the queue carried a "Queued until the agent rests · Send now · Take
// back" line of its own. The maintainer (2026-10-15): "we definitely don't need the Send Now button under
// every one of the messages . it applies to all three", and of the line: "I don't think we need the
// little message that says 'Queued until the agent rests'". So: one Send now under the run, always
// visible, that stops waiting one step at a time — a held run goes to the agent's next step
// (`releaseOnly`), a queued steer is pushed through now.
//
// ⌘⏎ PRESSES IT (2026-10-19) whenever nothing is typed: from the empty prompt box, from anywhere else in
// the thread's surface, and from a page with nothing focused. With words typed, ⌘⏎ is still the prompt
// box's own forced send. The control wears the chord on a flat keycap to the left of its words, where
// an arrow stood (send-now-shortcut-mockup-fixture, O). Both surfaces are driven: the drawer and the full
// page (the queue card was the third until it went, 2026-11-10).
//
// Everything here needs a REAL browser: the control is mounted by each surface under its own queued
// tail (the drawer's virtualized rows), so where it lands, what it says and what it asks the server for
// are facts of the rendered page.
//
// Run against queued-spacing-fixture.html on a plain Vite dev server (fixtures are NOT servable through
// the frizz stack — its Vite runs in middleware mode and falls back to index.html for every unknown path):
//   (cd packages/web && nubx vite --port 5412 --strictPort)
//   nub scripts/verify-queued-send-now.mjs --url=http://localhost:5412/queued-spacing-fixture.html
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const base = opt("url", "http://localhost:5412/queued-spacing-fixture.html")
const at = (query) => `${base}${base.includes("?") ? "&" : "?"}${query}`
const shots = opt("shots")
if (shots) mkdirSync(shots, { recursive: true })

const { launchHeadless } = await import("./lib/headless-browser.mjs")
const browser = await launchHeadless({ protocolTimeout: 60_000 })
let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`) }
const pass = (msg) => console.log(`PASS  ${msg}`)
const near = (a, b, tol) => Math.abs(a - b) <= tol

const CONTROL = "[data-queued-send-now]"
const pageErrors = []

async function open(query, width = 900) {
  const page = await browser.newPage()
  await page.setViewport({ width, height: 800, deviceScaleFactor: 2 })
  page.on("pageerror", (e) => pageErrors.push(`${query}: ${e}`))
  await page.goto(at(query), { waitUntil: "networkidle0", timeout: 60000 })
  // The transcript settles over a few frames after the fetch; the queued bubbles are the signal.
  await page.waitForSelector(`[data-frizz-msg="q3"]`, { timeout: 15000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 300))
  return page
}

// What the surface drew: every control, every "Send now" anywhere, any status words, and where the
// control sits against the last queued bubble.
const read = (page) => page.evaluate((sel) => {
  const controls = [...document.querySelectorAll(sel)]
  const sendNows = [...document.querySelectorAll("button")].filter((b) => /send now/i.test(b.textContent ?? "") || /send now/i.test(b.getAttribute("aria-label") ?? ""))
  const last = document.querySelector(`[data-frizz-msg="q3"]`)
  const c = controls[0]
  const lb = last?.getBoundingClientRect()
  const cb = c?.getBoundingClientRect()
  // The words, after the keycap's wrapper.
  const label = c?.querySelector("button > span:last-child")
  return {
    count: controls.length,
    sendNows: sendNows.length,
    mode: c?.dataset.queuedSendNow ?? null,
    statusWords: document.body.textContent.includes("Queued until the agent rests"),
    visible: c ? Number(getComputedStyle(c).opacity) === 1 && cb.height > 0 : false,
    // The label's right edge against the bubble's: the run's right edge is one line.
    rightDelta: c && lb ? label.getBoundingClientRect().right - lb.right : null,
    // The control's box top against the bubble's bottom: the run's own 6px pitch.
    gap: c && lb ? cb.top - lb.bottom : null,
    viewportRight: cb ? window.innerWidth - cb.right : null,
  }
}, CONTROL)

try {
  // 1. THE DRAWER, a queued steer on a running Claude turn: one control, visible at rest, for the run.
  {
    const page = await open("surface=drawer")
    const r = await read(page)
    if (r.count !== 1) fail(`drawer: expected ONE control under the run, saw ${r.count}`)
    else if (r.sendNows !== 1) fail(`drawer: ${r.sendNows} "Send now" buttons on the page — a bubble still carries its own`)
    else pass("drawer: one Send now for three queued messages, and no bubble carries its own")
    if (!r.visible) fail("drawer: the control is not visible at rest")
    else pass("drawer: visible at rest, no hover needed")
    if (r.mode !== "interrupt") fail(`drawer: a queued steer reads as "${r.mode}", expected interrupt`)
    else pass("drawer: a queued steer is pushed through (interrupt)")
    if (!near(r.rightDelta, 0, 0.5)) fail(`drawer: label is ${r.rightDelta.toFixed(2)}px off the bubble's right edge`)
    else pass(`drawer: flush with the run's right edge (${r.rightDelta.toFixed(2)}px)`)
    if (!near(r.gap, 6, 0.5)) fail(`drawer: control sits ${r.gap.toFixed(2)}px under the last bubble, expected the run's 6px`)
    else pass(`drawer: ${r.gap.toFixed(2)}px under the last bubble — the run's own pitch`)

    // 2. THE ⚡ IS STILL GONE. This thread is `runtime: "running"` on Claude — the state that used to
    //    grow a lightning bolt in the composer rail — so its absence here is a real control.
    const bolt = await page.$$eval("[data-thread-composer-box] button", (els) => els.map((e) => e.getAttribute("aria-label")).filter(Boolean))
    if (bolt.some((l) => /interrupt/i.test(l))) fail(`the composer carries an interrupt button: ${JSON.stringify(bolt)}`)
    else pass("no interrupt button in the composer rail")

    // 3. OPTICAL: the keycap's box centred on the words' CAP BAND (visual-review Rule 2). The text node
    //    is wrapped in its own inline span and probed inside it, so the probe reads the inline baseline
    //    rather than a flex line's centre. Measured at the shipped size and at double it: the cap is
    //    sized and lifted in `em`/`cap`, so the residual must hold at both. The old arrow is gone.
    const optical = (fontSize) => page.evaluate((sel, fontSize) => {
      const c = document.querySelector(sel)
      if (fontSize) c.style.fontSize = fontSize
      const label = c.querySelector("button > span:last-child")
      const node = [...label.childNodes].find((n) => n.nodeType === 3)
      const span = document.createElement("span")
      label.insertBefore(span, node)
      span.appendChild(node)
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
      span.appendChild(probe)
      const baseline = probe.getBoundingClientRect().bottom
      // Read while the span is still in the page: a detached element's computed style is empty, and an
      // empty font string leaves the canvas measuring its own 10px default.
      const cs = getComputedStyle(span)
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const size = cs.fontSize
      probe.remove()
      label.insertBefore(node, span)
      span.remove()
      const ctx = document.createElement("canvas").getContext("2d")
      ctx.font = font
      const cap = ctx.measureText("H").actualBoundingBoxAscent
      // The cap's border IS its ink: its box is what the eye reads beside the words.
      const key = c.querySelector("kbd").getBoundingClientRect()
      const textLeft = (() => { const range = document.createRange(); range.selectNodeContents(label); return range.getBoundingClientRect().left })()
      const svgs = c.querySelectorAll("svg").length
      const glyphs = c.querySelector("kbd").textContent
      if (fontSize) c.style.fontSize = ""
      // NEGATIVE = the cap sits BELOW the cap band's centre.
      return { residual: (baseline - cap / 2) - (key.top + key.bottom) / 2, fontSize: size, gap: textLeft - key.right, em: parseFloat(size), svgs, glyphs }
    }, CONTROL, fontSize)
    const shipped = await optical(null)
    const doubled = await optical("23px")
    if (shipped.glyphs !== "⌘⏎" || shipped.svgs !== 0) fail(`the control draws ${shipped.svgs} svg(s) and a cap reading "${shipped.glyphs}", expected the ⌘⏎ cap and no arrow`)
    else pass("the control wears a ⌘⏎ keycap and no arrow")
    if (Math.abs(shipped.residual) > 0.6) fail(`keycap ${shipped.residual.toFixed(2)}px off the cap band at ${shipped.fontSize}`)
    else pass(`keycap centred on the words' cap band at ${shipped.fontSize} (${shipped.residual.toFixed(2)}px residual)`)
    if (Math.abs(doubled.residual) > 1.2) fail(`keycap ${doubled.residual.toFixed(2)}px off the cap band at ${doubled.fontSize}`)
    else pass(`…and at ${doubled.fontSize} (${doubled.residual.toFixed(2)}px), so it tracks the type`)
    // 0.44em from the cap's border to the words' box: the 5.5px of ink the arrow kept from the words.
    if (!near(shipped.gap, 0.44 * shipped.em, 0.3)) fail(`keycap → words ${shipped.gap.toFixed(2)}px, expected ${(0.44 * shipped.em).toFixed(2)}px`)
    else pass(`keycap → words ${shipped.gap.toFixed(2)}px (0.44em)`)

    // 4. HOVER brightens it — the words, and the keycap's glyphs to the words' colour and its hairline
    //    to grey — on a 50ms fade. The bubbles keep their own take-back lift, which is still per message.
    const tone = () => page.$eval(`${CONTROL} button`, (b) => {
      const k = getComputedStyle(b.querySelector("kbd"))
      return { words: getComputedStyle(b).color, key: k.color, hairline: k.borderTopColor, fade: [getComputedStyle(b).transitionDuration, k.transitionDuration] }
    })
    const before = await tone()
    await page.hover(`${CONTROL} button`)
    await new Promise((r) => setTimeout(r, 250))
    const after = await tone()
    if (before.words === after.words) fail(`hover leaves the control's colour at ${before.words}`)
    else pass(`hover lifts the control (${before.words} → ${after.words})`)
    if (after.key !== after.words || before.key === after.key) fail(`hover leaves the keycap's glyphs at ${after.key}, words at ${after.words}`)
    else pass(`hover lifts the keycap's glyphs with the words (${before.key} → ${after.key})`)
    if (before.hairline === after.hairline || after.hairline === after.words) fail(`hover takes the keycap's hairline ${before.hairline} → ${after.hairline}, expected a lift short of the words`)
    else pass(`hover lifts the keycap's hairline to grey (${before.hairline} → ${after.hairline})`)
    if (before.fade.some((d) => d !== "0.05s" && !d.startsWith("0.05s,"))) fail(`fades run ${JSON.stringify(before.fade)}, expected 50ms`)
    else pass(`the fade is 50ms (${before.fade.join(" / ")})`)
    await page.hover(`[data-frizz-msg="q2"] [data-unqueue]`)
    await new Promise((r) => setTimeout(r, 300))
    const lift = await page.$eval(`[data-frizz-msg="q2"] [data-unqueue]`, (b) => Number(getComputedStyle(b).opacity))
    if (!near(lift, 1, 0.01)) fail(`a queued bubble no longer lifts on hover (opacity ${lift})`)
    else pass("a queued bubble still lifts to full on hover, to be taken back")
    if (shots) await page.screenshot({ path: join(shots, "send-now-drawer.png") })

    // 5. THE CLICK asks the server to push this thread's queue through — no message, no release.
    await page.click(`${CONTROL} button`)
    await new Promise((r) => setTimeout(r, 400))
    const calls = await page.evaluate(() => window.__pushNowCalls ?? [])
    if (calls.length !== 1) fail(`expected exactly one deliverQueuedNow call, saw ${calls.length}`)
    else if (calls[0].slug !== "queued-spacing" || !calls[0].sessionId || calls[0].releaseOnly) fail(`bad payload: ${JSON.stringify(calls[0])}`)
    else if ("message" in calls[0] || "deliveryId" in calls[0]) fail(`the click re-sent content: ${JSON.stringify(calls[0])}`)
    else pass(`click → deliverQueuedNow(${JSON.stringify(calls[0])})`)
    await page.close()
  }

  // 6. SENT TO THE QUEUE: the same one control, now releasing what Frizz holds — and no status words.
  {
    const page = await open("surface=drawer&held=1")
    const r = await read(page)
    if (r.count !== 1 || r.sendNows !== 1) fail(`held: expected one Send now, saw ${r.count} controls and ${r.sendNows} buttons`)
    else if (r.mode !== "release") fail(`held: the control reads "${r.mode}", expected release`)
    else pass("held: one Send now, releasing the run to the agent's next step")
    if (r.statusWords) fail(`held: "Queued until the agent rests" is still drawn`)
    else pass("held: no status line")
    await page.click(`${CONTROL} button`)
    await new Promise((r) => setTimeout(r, 400))
    const calls = await page.evaluate(() => window.__pushNowCalls ?? [])
    if (calls.length !== 1 || calls[0].releaseOnly !== true) fail(`held click: ${JSON.stringify(calls)}`)
    else pass(`held click → deliverQueuedNow(${JSON.stringify(calls[0])}) — released, not interrupted`)
    await page.close()
  }

  // 7. ⌘⏎ PRESSES IT, on every surface, from wherever nothing is typed — and with words typed it is still
  //    the prompt box's own send. Each case opens a fresh page, so the calls it reads are its own.
  const BOX = "[data-thread-composer-box] textarea"
  const chord = async (page, mod = "Meta", extra) => {
    await page.keyboard.down(mod)
    if (extra) await page.keyboard.down(extra)
    await page.keyboard.press("Enter")
    if (extra) await page.keyboard.up(extra)
    await page.keyboard.up(mod)
    await new Promise((r) => setTimeout(r, 400))
  }
  const calls = (page) => page.evaluate(() => ({ push: window.__pushNowCalls ?? [], typed: window.__followUpCalls ?? [] }))
  const focusOn = {
    box: (page) => page.focus(BOX),
    // A focusable element of the surface that edits nothing: the drawer's transcript, or the full page's
    // own header button, focused the way a keyboard user lands on it.
    transcript: (page) => page.evaluate(() => {
      const el = document.querySelector("[data-drawer-transcript-scroll]") ?? document.querySelector("[data-thread-surface] button:not([data-send-now])")
      el.focus()
      return el !== null && document.activeElement === el
    }),
    nothing: (page) => page.evaluate(() => { document.activeElement?.blur(); return document.activeElement === document.body }),
  }
  for (const [query, where, expect, mod, extra] of [
    ["surface=drawer", "box", "interrupt"],
    ["surface=drawer", "box", "interrupt", "Control"],
    ["surface=drawer", "transcript", "interrupt"],
    ["surface=drawer", "nothing", "interrupt"],
    ["surface=drawer&held=1", "box", "release"],
    ["surface=full", "box", "interrupt"],
    ["surface=full", "nothing", "interrupt"],
    ["", "box", "interrupt"],
    ["held=1", "transcript", "release"],
    ["surface=drawer", "box", null, "Meta", "Shift"],
    ["surface=drawer&backend=codex", "box", null],
    ["surface=drawer&queued=0", "box", null],
  ]) {
    const page = await open(query)
    const name = `⌘⏎ ${mod === "Control" ? "(Ctrl) " : ""}${extra ? `+${extra} ` : ""}${query}, focus on ${where}`
    const landed = await focusOn[where](page)
    if (landed === false) { fail(`${name}: could not put focus there`); await page.close(); continue }
    await chord(page, mod, extra)
    const { push, typed } = await calls(page)
    if (typed.length) fail(`${name}: sent a typed message ${JSON.stringify(typed)}`)
    else if (expect === null) {
      if (push.length) fail(`${name}: pressed Send now where it should not — ${JSON.stringify(push)}`)
      else pass(`${name}: nothing pressed`)
    } else if (push.length !== 1) fail(`${name}: expected one Send now press, saw ${JSON.stringify(push)}`)
    else if ((push[0].releaseOnly === true) !== (expect === "release") || push[0].slug !== "queued-spacing" || !push[0].sessionId) fail(`${name}: bad press ${JSON.stringify(push[0])}`)
    else {
      // The caret stays where it was: pressing Send now from the box leaves you in the box.
      const kept = where !== "box" || await page.evaluate((sel) => document.activeElement === document.querySelector(sel), BOX)
      if (!kept) fail(`${name}: pressed (${expect}) but took the caret out of the prompt box`)
      else pass(`${name} → ${expect}`)
    }
    await page.close()
  }
  // With words typed, ⌘⏎ stays the prompt box's: the words go now, and Send now is not pressed.
  {
    const page = await open("surface=drawer")
    await page.focus(BOX)
    await page.keyboard.type("stop and read this")
    await chord(page)
    const { push, typed } = await calls(page)
    if (push.length) fail(`typed + ⌘⏎ pressed Send now: ${JSON.stringify(push)}`)
    else if (typed.length !== 1 || !String(typed[0].message).includes("stop and read this") || typed[0].interrupt !== true) fail(`typed + ⌘⏎: ${JSON.stringify(typed)}`)
    else pass("typed + ⌘⏎ sends the words now (interrupt), and Send now is left alone")
    await page.close()
  }

  // 8. NEGATIVE CONTROLS. Codex takes a steer straight into its turn, so a queued steer there has
  //    nothing to push; a run Frizz holds still releases. And with nothing queued, nothing draws.
  for (const [query, expected, why] of [
    ["surface=drawer&backend=codex", 0, "codex steer: no queue to push, no control"],
    ["surface=drawer&backend=codex&held=1", 1, "codex held: Frizz still releases it"],
    ["surface=drawer&queued=0", 0, "nothing queued: no control"],
  ]) {
    const page = await open(query)
    const n = await page.$$eval(CONTROL, (els) => els.length)
    if (n !== expected) fail(`${why} — saw ${n}`)
    else pass(why)
    await page.close()
  }

  // 9. NARROW. The run's right edge is the pane's, so the control must stay inside it.
  {
    const page = await open("surface=drawer", 420)
    const r = await read(page)
    if (r.count !== 1 || r.viewportRight < 0 || !near(r.rightDelta, 0, 0.5)) fail(`at 420px: ${JSON.stringify(r)}`)
    else pass(`at 420px the control stays flush with the run, ${r.viewportRight.toFixed(1)}px inside the pane`)
    if (shots) await page.screenshot({ path: join(shots, "send-now-narrow.png") })
    await page.close()
  }

  if (pageErrors.length) fail(`page errors: ${JSON.stringify(pageErrors)}`)
  else pass("no page errors")
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS")
process.exit(failures ? 1 : 0)
