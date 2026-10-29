import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../packages/web/node_modules/vite/dist/node/index.js'
import { launchHeadless } from './lib/headless-browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(process.env.THEME_EVIDENCE_DIR ?? '.adhoc-shots/control-chrome')
const baseline = process.argv.includes('--baseline')
mkdirSync(out, { recursive: true })
const server = await createServer({ root: join(root, 'packages/web'), configFile: join(root, 'packages/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
const results = [], errors = []
try {
  await server.listen()
  browser = await launchHeadless()
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  for (const theme of ['light', 'dark']) for (const width of [1100, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 2, isMobile: false, hasTouch: false })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/question-recommendation-fixture.html`, { waitUntil: 'networkidle2' })
    await page.evaluate(async theme => {
      (await import('/src/lib/theme.ts')).setThemePreference(theme)
      ;(await import('/src/lib/font.ts')).initFont()
    }, theme)
    const ink = await page.evaluate(() => [...document.querySelectorAll('[data-case]')].flatMap(sample => {
      const badge = [...sample.querySelectorAll('span')].find(el => el.textContent === 'Recommended')
      if (!badge) return []
      const label = badge.nextElementSibling
      const center = element => {
        // Before the first child: a wrapped answer must measure its FIRST line, not its last.
        const probe = document.createElement('span')
        probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0'
        element.prepend(probe)
        const baseline = probe.getBoundingClientRect().bottom
        probe.remove()
        const style = getComputedStyle(element), canvas = document.createElement('canvas').getContext('2d')
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        return baseline - canvas.measureText('H').actualBoundingBoxAscent / 2
      }
      const labelCenter = center(label), badgeCenter = center(badge), box = badge.getBoundingClientRect()
      return [{ sample: sample.dataset.case, labelCenter, textResidual: +(badgeCenter - labelCenter).toFixed(3), borderResidual: +((box.top + box.bottom) / 2 - labelCenter).toFixed(3), height: box.height }]
    }))
    assert.deepEqual(ink.map(item => item.sample), ['inline-long', 'inline-short', 'legacy-fallback'])
    results.push({ theme, width, ink })
    if (!baseline) for (const item of ink) {
      assert.ok(Math.abs(item.textResidual) < .5, JSON.stringify(item))
      assert.ok(Math.abs(item.borderResidual) < .5, JSON.stringify(item))
    }
    await (await page.$('[data-case="inline-short"]')).screenshot({ path: join(out, `${theme}-${width}-recommendation.png`) })
    if (!baseline) {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/icon-rhythm-fixture.html`, { waitUntil: 'networkidle2' })
      await page.evaluate(async theme => (await import('/src/lib/theme.ts')).setThemePreference(theme), theme)
      const selectors = ['[data-header-shell] .icon-focus-outline', 'button[title^="Attach"]', '[aria-label="Start threads from issues and PRs"]', '[aria-label="Send"]']
      const edge = selector => page.$eval(selector, el => getComputedStyle(el).getPropertyValue('--tw-inset-ring-shadow'))
      // The PAINTED edge two frames into the focus, not the variable: `--tw-inset-ring-shadow` flips at
      // once even when a box-shadow transition holds the drawn edge transparent until its last frame —
      // the GitHub icon and send button hitch this check used to pass (styles.css, icon-focus-outline).
      const paintedEdge = selector => page.$eval(selector, el => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(getComputedStyle(el).boxShadow.split(/,(?![^(]*\))/).find(layer => layer.includes('inset')) ?? '')))))
      const fill = selector => page.$eval(selector, el => getComputedStyle(el).backgroundColor)
      for (const selector of selectors) {
        await page.mouse.move(0, 0)
        await page.evaluate(() => document.activeElement?.blur())
        assert.doesNotMatch(await edge(selector), /inset/, `No resting icon edge: ${selector}`)
        const restFill = await fill(selector)
        // A hover changes the fill and draws no edge (maintainer 2026-10-29: "No borders ever, just a
        // background color change").
        await page.hover(selector)
        assert.doesNotMatch(await edge(selector), /inset/, `Hover draws no icon edge: ${selector}`)
        // The fill rides the 120ms colour transition, so it is read once that has settled. Send is the
        // exception: a filled primary button, whose hover dims it rather than filling it.
        await new Promise(resolve => setTimeout(resolve, 250))
        if (selector !== '[aria-label="Send"]') assert.notEqual(await fill(selector), restFill, `Hover changes the icon's fill: ${selector}`)
        await page.mouse.move(0, 0)
        await page.keyboard.press('Tab')
        await page.focus(selector)
        const painted = await paintedEdge(selector)
        assert.match(painted, /1px inset/, `Keyboard focus paints the icon edge at once: ${selector}`)
        assert.doesNotMatch(painted, /^\s*(rgba\(0, 0, 0, 0\)|transparent)/, `Keyboard focus paints the icon edge at once, not transparent: ${selector}`)
      }
      await page.evaluate(() => document.activeElement?.blur())
      await page.mouse.move(0, 0)
      await (await page.$('[data-header-shell]')).screenshot({ path: join(out, `${theme}-${width}-header-rest.png`) })
      await page.hover(selectors[0])
      await (await page.$('[data-header-shell]')).screenshot({ path: join(out, `${theme}-${width}-header-hover.png`) })
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
      await page.reload({ waitUntil: 'networkidle2' })
      await page.hover(selectors[0])
      assert.doesNotMatch(await edge(selectors[0]), /inset/, 'Touch devices do not get sticky hover outlines')
    }
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(results, null, 2))
} finally {
  writeFileSync(join(out, 'recommendation-ink.json'), JSON.stringify({ results, errors }, null, 2))
  if (browser) { const pid = browser.process().pid; await browser.close(); console.log('CLOSED', pid) }
  await server.close()
}
