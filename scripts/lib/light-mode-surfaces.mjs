import assert from "node:assert/strict"
import { join } from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { measureTextContrast, measureControlContrast } from "./light-mode-contrast.mjs"

export async function checkSurfaceStates({ page, url, font, palette, out, check, result }) {
  const name = `${palette}-${font}`
  const shot = async suffix => page.screenshot({ path: join(out, `${name}-${suffix}.png`) })
  const contrast = async suffix => { result[`${name}-${suffix}-contrast`] = await measureTextContrast(page) }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: "networkidle2" })
  await page.evaluate(async () => {
    const { store } = await import("/src/store.ts")
    store.sidebarCollapsed.snoozed = false
    store.sidebarCollapsed.inactive = false
  })
  await page.waitForSelector('[data-sidebar-item="theme-snoozed"]')
  await page.waitForSelector('[data-sidebar-item="theme-done"]')
  await contrast("expanded-bands")
  await shot("expanded-bands")
  const running = await page.evaluate(async () => (await import("/src/store.ts")).store.board.threads.find(t => t.id === "theme-running").runtime)
  assert.equal(running, "running")
  check(`${name} real Rested, Active, Snoozed and Done bands`)

  await page.goto(`${url}/thread/theme-question/full`, { waitUntil: "networkidle2" })
  await page.click("[data-question-option] > button")
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(el => el.textContent.trim() === "Send answers" && !el.disabled && getComputedStyle(el).opacity === "1"))
  await contrast("selected-question")
  await shot("selected-question")
  await page.evaluate(() => {
    const text = document.querySelector('[data-question-option] p') ?? document.querySelector('[data-question-option] span')
    const range = document.createRange(); range.selectNodeContents(text)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  })
  assert.ok(await page.evaluate(() => getSelection().toString().length > 0))
  await shot("text-selection")
  await page.evaluate(() => getSelection().removeAllRanges())

  await page.goto(url, { waitUntil: "networkidle2" })
  await page.evaluate(async () => { (await import("/src/store.ts")).store.showSettings = true })
  await page.waitForSelector('button[aria-label="Appearance"]')
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".frizz-sheet-panel").parentElement).opacity === "1")
  let serverWrites = 0
  const request = req => { if (req.url().includes("settingsSet")) serverWrites++ }
  page.on("request", request)
  for (const choice of [palette === "light" ? "Dark" : "Light", palette === "light" ? "Light" : "Dark"]) {
    await page.click('button[aria-label="Appearance"]')
    await page.waitForSelector('[role="menuitemradio"]')
    if (choice.toLowerCase() !== palette) {
      await contrast("appearance-menu")
      await shot("appearance-menu")
    }
    await page.evaluate(choice => [...document.querySelectorAll('[role="menuitemradio"]')].find(el => el.textContent.trim() === choice).click(), choice)
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, {}, choice.toLowerCase())
  }
  page.off("request", request)
  assert.equal(serverWrites, 0, "Appearance never writes server settings")
  await page.keyboard.press("Tab")
  await page.focus('button[aria-label="Appearance"]')
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  })
  const controls = await measureControlContrast(page, [
    { label: 'Appearance border', selector: 'button[aria-label="Appearance"]', property: 'borderTopColor' },
    { label: 'Appearance focus', selector: 'button[aria-label="Appearance"]', property: 'outlineColor' },
    { label: 'Appearance chevron', selector: 'button[aria-label="Appearance"] svg', property: 'color' },
  ])
  result[`${name}-controls`] = controls
  if (palette === 'light') assert.deepEqual(controls.filter(c => c.ratio < 3), [], 'Meaningful controls meet 3:1')
  await shot("appearance-focus")
  await page.hover('button[aria-label="About Appearance"]')
  await page.waitForSelector('[role="tooltip"]')
  await contrast("appearance-help")
  await shot("appearance-help")
  check(`${name} Appearance menu, help, focus and browser-only persistence`)

  const inspectDestructive = async label => {
    const selector = '[role="dialog"] button[class*="bg-danger"]'
    await page.waitForSelector(selector, { visible: true })
    const settle = () => page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
    })
    await page.mouse.move(0, 0)
    await settle()
    assert.equal(await page.$eval(selector, el => getComputedStyle(el).opacity), '1', 'The normal sample is fully opaque')
    await contrast(`${label}-normal`)
    const input = await page.createCDPSession()
    try {
      await input.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      await page.hover(selector)
      await settle()
      assert.equal(await page.$eval(selector, el => getComputedStyle(el).opacity), '1', 'Touch-only input is a negative control for the media-gated hover rule')
      if (process.env.THEME_VERIFY_HOVER_NONE === '1') {
        assert.equal(await page.evaluate(() => matchMedia('(hover: hover)').matches), false, 'The forced no-hover run must exercise the fallback')
      } else {
        await input.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      }
      // Headless hosts without hover input need the equivalent media endpoint. Reuse the compiled
      // hover rules, not an inline opacity that could hide a regression in those rules.
      const media = await page.evaluateHandle(() => {
        const changed = []
        if (!matchMedia('(hover: hover)').matches) {
          const visit = rules => {
            for (const rule of rules) {
              if (rule.type === CSSRule.MEDIA_RULE && /^\(hover:\s*hover\)$/.test(rule.conditionText)) {
                changed.push({ rule, condition: rule.media.mediaText })
                rule.media.mediaText = 'all'
              }
              if (rule.cssRules) visit(rule.cssRules)
            }
          }
          for (const sheet of document.styleSheets) visit(sheet.cssRules)
          if (!changed.length) throw new Error('No compiled hover media rules were found')
        }
        return changed
      })
      try {
        result[`${name}-${label}-hover-input`] = await media.evaluate(changed => changed.length ? 'equivalent CSS media endpoint' : 'native pointer hover')
        await page.hover(selector)
        await settle()
        assert.deepEqual(await page.$eval(selector, el => ({ hovered: el.matches(':hover'), opacity: getComputedStyle(el).opacity })), { hovered: true, opacity: '0.9' }, 'The compiled CSS hover endpoint is active before sampling')
        await contrast(`${label}-hover`)
        await shot(`${label}-hover`)
      } finally {
        await media.evaluate(changed => { for (const { rule, condition } of changed) rule.media.mediaText = condition })
        await media.dispose()
      }
    } finally {
      await input.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await input.detach()
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="dialog"]', { hidden: true })
  }
  await page.goto(new URL('/', url).href, { waitUntil: 'networkidle2' })
  await page.hover('[aria-label="More actions for theme-project"]')
  await page.click('[aria-label="More actions for theme-project"]')
  await page.click('[role="menuitem"]')
  await inspectDestructive('delete-project')
  await page.goto(`${url}/thread/theme-rich/full`, { waitUntil: 'networkidle2' })
  // The alias trims whitespace; skip skill discovery against the transcript-only fixture.
  await page.type('textarea', ' /logout')
  await page.keyboard.down('Meta')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Meta')
  await inspectDestructive('sign-out')
  check(`${name} destructive confirmation labels in normal and pointer-hover states, without submitting either action`)

  await page.goto(`${url}/thread/theme-rich/full`, { waitUntil: "networkidle2" })
  await page.evaluate(() => [...document.querySelectorAll('button[aria-expanded="false"]')].find(el => el.textContent.includes("Ran 3 tool calls"))?.click())
  await page.waitForSelector(".frizz-diff")
  await page.$eval('[data-drawer-transcript-scroll]', el => { el.scrollTop = 0 })
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('.frizz-diff-header button[aria-expanded="false"],.frizz-bash-header button[aria-expanded="false"],button.frizz-bash-header[aria-expanded="false"]')) button.click()
  })
  await page.waitForSelector('.frizz-diff-body:not([hidden])')
  await page.waitForFunction(() => [...document.querySelectorAll('.frizz-bash-body')].some(el => el.textContent.includes('const palette')))
  await contrast("tool-diff")
  await shot("tool-diff")
  check(`${name} real Edit diff, Read excerpt and failed tool`)

  // The embedded Vite server serves one HTML entry. Select the existing component-gallery entry
  // for this complementary renderer check; its network fixture is not claimed as GitHub E2E.
  // A real loopback response keeps Chrome's network address-space classification intact. Fulfilling
  // the document through request interception classifies it public and blocks Vite's loopback HMR.
  const gallery = createServer(async (req, res) => {
    try {
      const isEntry = req.url.startsWith('/github-hovercard-fixture.html')
      const upstream = await fetch(isEntry ? url : new URL(req.url, url))
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' })
      res.end(isEntry ? (await upstream.text()).replace('/src/main.tsx', '/src/github-hovercard-fixture.tsx') : Buffer.from(await upstream.arrayBuffer()))
    } catch (error) { res.writeHead(502); res.end(String(error)) }
  })
  gallery.listen(0, '127.0.0.1')
  await once(gallery, 'listening')
  try {
  await page.goto(`http://127.0.0.1:${gallery.address().port}/github-hovercard-fixture.html?font=${font}&theme=${palette}`, { waitUntil: "networkidle2" })
  await page.waitForSelector('[data-case="issue-closed"]')
  const readings = []
  for (const y of [0, 600, 1200, 1800]) {
    await page.evaluate(y => scrollTo(0, y), y)
    readings.push(...await measureTextContrast(page))
  }
  result[`${name}-github-components-contrast`] = readings
  await page.evaluate(() => scrollTo(0, 0))
  await shot("github-components")
  check(`${name} actual GitHub card components: all states and external label edge cases`)
  } finally {
    await page.goto(url, { waitUntil: "networkidle2" })
    gallery.closeAllConnections()
    await new Promise(resolve => gallery.close(resolve))
  }

  await page.goto(url, { waitUntil: "networkidle2" })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.waitForSelector('[data-mobile-tab="snoozed"]')
  for (const band of ["snoozed", "done", "queue"]) {
    await page.click(`[data-mobile-tab="${band}"]`)
    await contrast(`phone-${band}`)
    await shot(`phone-${band}`)
  }
  await page.goto(`${url}/thread/theme-question/full`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-question-option]')
  await contrast('phone-question')
  await shot('phone-question')
  await page.goto(url, { waitUntil: 'networkidle2' })
  await page.click('[data-mobile-more]')
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-mobile-more-sheet] > div')
    return panel && Math.abs(panel.getBoundingClientRect().bottom - innerHeight) < .5
  })
  await contrast('phone-actions')
  await shot('phone-actions')
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: "networkidle2" })
}
